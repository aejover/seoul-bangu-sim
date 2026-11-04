import * as THREE from 'three/webgpu';

// 센 방구는 가로수와 길가 물건(쓰레기통, 벤치, 소화전, 가로등)을 날리고, 아주 세면 빌딩까지 날려 버린다.
// 원래 자리의 빌딩/물건은 숨기고, 똑같이 생긴 조각을 따로 만들어 던진다.

// 물건마다 날아가는 세기 (N, 내 엉덩이에서 멀수록 약해진 값). 가벼울수록 잘 날아간다
const PROPS = {
	Trashcans: { threshold: 60, max: 120 },
	Benches: { threshold: 95, max: 80 },
	Hydrants: { threshold: 110, max: 80 },
	StreetTrees: { threshold: 150, max: 240, lie: true },
	Streetlights: { threshold: 230, max: 80, lie: true }
};
const TOWER_THRESHOLD = 480; // 빌딩이 날아가는 세기 (N)
const MAX_FLYING = 12; // 한꺼번에 날아다니는 빌딩 수 상한 (성능)

export class Destruction {

	constructor( scene, tilesGroup, world, sunLight, sound ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.world = world;
		this.sunLight = sunLight;
		this.sound = sound;
		this.towers = [];
		this.props = [];
		this.debris = {};
		this.flying = [];
		this.flyingProps = [];
		this.events = [];
		this.shadowRefresh = - 1;
		this.pulse = 0;

		this.index();

	}

	index() {

		this.scene.updateMatrixWorld( true );
		const boxes = new Map();
		for ( const b of this.world.towers ) boxes.set( `${ Math.round( b.cx ) },${ Math.round( b.cz ) }`, b );

		const p = new THREE.Vector3();
		const m = new THREE.Matrix4();
		const sources = {};

		for ( const tile of this.tilesGroup.children ) {

			tile.traverse( ( o ) => {

				if ( o.isLOD ) {

					o.getWorldPosition( p );
					let box = null;

					for ( let dx = - 1; dx <= 1 && ! box; dx ++ ) {

						for ( let dz = - 1; dz <= 1 && ! box; dz ++ ) box = boxes.get( `${ Math.round( p.x ) + dx },${ Math.round( p.z ) + dz }` ) || null;

					}

					// 날아갈 때는 멀리 있는 빌딩용 싼 재질을 쓴다
					const far = o.levels[ 1 ] ? o.levels[ 1 ].object.material : o.levels[ 0 ].object.material;
					this.towers.push( { lod: o, mesh: o.levels[ 0 ].object, material: far, box, center: p.clone(), gone: false } );

				} else if ( o.isInstancedMesh && PROPS[ o.name ] ) {

					sources[ o.name ] = sources[ o.name ] || o;

					for ( let i = 0; i < o.count; i ++ ) {

						o.getMatrixAt( i, m );
						const local = m.clone();
						m.premultiply( o.matrixWorld );
						p.setFromMatrixPosition( m );
						if ( m.elements[ 0 ] === 0 && m.elements[ 5 ] === 0 ) continue;
						this.props.push( { type: o.name, mesh: o, index: i, pos: p.clone(), matrix: m.clone(), local, gone: false } );

					}

				}

			} );

		}

		// 날아가는 물건은 종류마다 인스턴스 하나에 모아서 그린다.
		// 처음부터 보이지 않는 인스턴스 하나를 그려 둬서 로딩 때 셰이더가 미리 만들어진다
		// (안 그러면 처음 날아가는 순간 GPU 가 수 초씩 멈춰 탭이 튕긴다)
		for ( const [ type, src ] of Object.entries( sources ) ) {

			const d = new THREE.InstancedMesh( src.geometry, src.material, PROPS[ type ].max );
			d.setMatrixAt( 0, new THREE.Matrix4().makeScale( 0, 0, 0 ) );
			d.count = 1;
			d.frustumCulled = false;
			d.castShadow = true;
			this.scene.add( d );
			this.debris[ type ] = d;

		}

		// 근처만 빨리 찾도록 격자에 넣는다
		this.cell = 40;
		this.grid = new Map();
		const add = ( key ) => {

			if ( ! this.grid.has( key ) ) this.grid.set( key, { towers: [], props: [] } );
			return this.grid.get( key );

		};

		for ( const t of this.towers ) add( this.key( t.center.x, t.center.z ) ).towers.push( t );
		for ( const t of this.props ) add( this.key( t.pos.x, t.pos.z ) ).props.push( t );

	}

	key( x, z ) {

		return `${ Math.floor( x / this.cell ) },${ Math.floor( z / this.cell ) }`;

	}

	near( center, radius, fn ) {

		const c = this.cell;
		for ( let gx = Math.floor( ( center.x - radius ) / c ); gx <= Math.floor( ( center.x + radius ) / c ); gx ++ ) {

			for ( let gz = Math.floor( ( center.z - radius ) / c ); gz <= Math.floor( ( center.z + radius ) / c ); gz ++ ) {

				const cell = this.grid.get( gx + ',' + gz );
				if ( cell ) fn( cell );

			}

		}

	}

	// 충격파: 반경 안에서 세기가 문턱을 넘는 것은 날아간다. 빌딩은 towers 가 참일 때만 (이륙선 넘는 방구)
	shock( center, force, radius, towersToo = false ) {

		let props = 0, towers = 0;

		this.near( center, radius, ( cell ) => {

			for ( const t of cell.props ) {

				if ( t.gone ) continue;
				const d = Math.hypot( t.pos.x - center.x, t.pos.z - center.z );
				if ( d > radius ) continue;
				const strength = force * ( 1 - d / radius );
				if ( strength > PROPS[ t.type ].threshold ) {

					this.throwProp( t, center, strength );
					props ++;

				}

			}

			if ( ! towersToo ) return;

			for ( const t of cell.towers ) {

				if ( t.gone || ! t.box ) continue;
				// 빌딩은 벽까지의 거리로 잰다
				const b = t.box;
				const ex = Math.max( b.x0 - center.x, 0, center.x - b.x1 );
				const ez = Math.max( b.z0 - center.z, 0, center.z - b.z1 );
				const d = Math.hypot( ex, ez );
				if ( d > radius ) continue;
				const strength = force * ( 1 - d / radius );
				if ( strength > TOWER_THRESHOLD && this.flying.length < MAX_FLYING ) {

					this.throwTower( t, center, strength );
					towers ++;

				}

			}

		} );

		if ( props || towers ) {

			this.tilesGroup.needsUpdate = true;
			this.shadowRefresh = 0.15; // 사라진 빌딩·나무의 그림자를 한 번 지운다
			this.events.push( { type: 'destroy', props, towers } );
			if ( towers ) this.sound.boom( Math.min( 1, towers / 3 + 0.4 ) );

		}

	}

	throwProp( t, center, strength ) {

		t.gone = true;
		t.mesh.setMatrixAt( t.index, _zero );
		t.mesh.instanceMatrix.needsUpdate = true;

		const debris = this.debris[ t.type ];
		const count = this.flyingProps.filter( ( f ) => f.type === t.type ).length;
		if ( ! debris || count >= PROPS[ t.type ].max ) return;

		const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
		t.matrix.decompose( pos, quat, scale );
		const dir = pos.clone().sub( center ).setY( 0 ).normalize();
		const light = PROPS[ t.type ].threshold < 120 ? 1.4 : 1;
		this.flyingProps.push( {
			type: t.type, pos, quat, scale, lie: PROPS[ t.type ].lie,
			vel: dir.multiplyScalar( ( 4 + strength / 30 ) * light ).setY( ( 5 + strength / 50 ) * light + Math.random() * 4 ),
			spin: new THREE.Vector3( Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5 ).multiplyScalar( 8 * light ),
			age: 0, landed: false
		} );

	}

	throwTower( t, center, strength ) {

		t.gone = true;
		t.box.gone = true;
		t.lod.visible = false;
		if ( this.onTower ) this.onTower( t.box ); // 빌딩에 붙은 간판도 같이 없앤다

		// 빌딩 지오메트리는 바닥이 원점이라, 가운데를 축으로 돌도록 한 단계 감싼다
		const geometry = t.mesh.geometry;
		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
		const bb = geometry.boundingBox;
		const half = ( bb.max.y - bb.min.y ) / 2;
		// 날아가는 동안은 그림자를 그리지 않는다 (큰 그림자 지도를 매번 다시 그리지 않게)
		const inner = new THREE.Mesh( geometry, t.material );
		inner.position.y = - ( bb.min.y + half );
		inner.receiveShadow = true;
		const mesh = new THREE.Group();
		t.lod.updateMatrixWorld( true );
		t.lod.matrixWorld.decompose( mesh.position, mesh.quaternion, mesh.scale );
		mesh.position.y += bb.min.y + half;
		mesh.add( inner );
		this.scene.add( mesh );

		const dir = t.center.clone().sub( center ).setY( 0 );
		if ( dir.lengthSq() < 1 ) dir.set( Math.random() - 0.5, 0, Math.random() - 0.5 );
		dir.normalize();
		const height = half * 2;
		const width = Math.max( t.box.w, t.box.d );
		// 키 큰 빌딩일수록 무겁다
		const heavy = 1 / Math.sqrt( Math.max( 1, height / 40 ) );

		this.flying.push( {
			mesh, height, width,
			vel: dir.multiplyScalar( ( 6 + strength / 22 ) * heavy ).setY( ( 8 + strength / 35 ) * heavy ),
			axis: new THREE.Vector3().crossVectors( new THREE.Vector3( 0, 1, 0 ), dir ).normalize(),
			spin: ( 0.4 + Math.random() * 0.6 ) * heavy,
			twist: ( Math.random() - 0.5 ) * 0.6,
			age: 0, bounces: 0, sinking: false
		} );

	}

	// 방구를 계속 세게 뀌고 있으면 분사 방향으로 주기적인 충격
	blast( dt, origin, physics, towersToo ) {

		this.pulse -= dt;
		if ( this.pulse > 0 ) return;
		this.pulse = 0.5;
		this.shock( origin, physics.force * 0.85, physics.reach * 0.9, towersToo );

	}

	update( dt ) {

		const g = 9.81;
		const q = new THREE.Quaternion();

		// 빌딩
		for ( const f of this.flying ) {

			f.age += dt;

			if ( f.sinking ) {

				f.mesh.position.y -= dt * ( 4 + f.age );
				continue;

			}

			f.vel.y -= g * dt;
			f.mesh.position.addScaledVector( f.vel, dt );
			q.setFromAxisAngle( f.axis, f.spin * dt );
			f.mesh.quaternion.premultiply( q );
			q.setFromAxisAngle( _up, f.twist * dt );
			f.mesh.quaternion.premultiply( q );

			// 쓰러지듯 땅에 닿으면 튀었다가 땅속으로 가라앉는다
			const up = Math.abs( _v.set( 0, 1, 0 ).applyQuaternion( f.mesh.quaternion ).y );
			const lowest = f.mesh.position.y - f.height * 0.5 * up - f.width * 0.5 * Math.sqrt( 1 - up * up );

			if ( lowest < 0 && f.vel.y < 0 ) {

				f.bounces ++;
				f.vel.y *= - 0.25;
				f.vel.x *= 0.5;
				f.vel.z *= 0.5;
				f.spin *= 0.5;
				this.sound.thud( 1, 30 );
				if ( f.bounces >= 2 ) {

					f.sinking = true;
					f.age = 0;

				}

			}

		}

		this.flying = this.flying.filter( ( f ) => {

			const done = f.sinking && f.age > 6;
			if ( done ) f.mesh.removeFromParent();
			return ! done;

		} );

		// 나무와 물건
		const e = new THREE.Euler();

		for ( const t of this.flyingProps ) {

			t.age += dt;

			if ( ! t.landed ) {

				t.vel.y -= g * dt;
				t.pos.addScaledVector( t.vel, dt );
				q.setFromEuler( e.set( t.spin.x * dt, t.spin.y * dt, t.spin.z * dt ) );
				t.quat.premultiply( q );
				const floor = this.world.heightAt( t.pos.x, t.pos.z );

				if ( t.pos.y < floor && t.vel.y < 0 ) {

					t.pos.y = floor;
					t.landed = true;
					t.age = 0;
					// 긴 것(나무, 가로등)은 옆으로 눕고, 작은 것은 아무렇게나 굴러 멈춘다
					const yaw = Math.random() * Math.PI * 2;
					t.quat.setFromEuler( t.lie ? e.set( Math.PI / 2 * 0.92, yaw, 0, 'YXZ' ) : e.set( ( Math.random() - 0.5 ) * 2, yaw, ( Math.random() - 0.5 ) * 2, 'YXZ' ) );

				}

			} else if ( t.age > 12 ) {

				t.scale.multiplyScalar( Math.max( 0, 1 - dt * 2 ) );

			}

		}

		this.flyingProps = this.flyingProps.filter( ( t ) => t.scale.x > 0.02 );

		for ( const [ type, d ] of Object.entries( this.debris ) ) {

			const list = this.flyingProps.filter( ( t ) => t.type === type );
			if ( list.length === 0 && d.count === 1 && ! d.dirty ) continue;
			d.count = Math.max( 1, list.length );
			if ( list.length === 0 ) d.setMatrixAt( 0, _zero );
			list.forEach( ( t, i ) => d.setMatrixAt( i, _m.compose( t.pos, t.quat, t.scale ) ) );
			d.instanceMatrix.needsUpdate = true;
			d.dirty = list.length > 0;

		}

		// 그림자는 빌딩·나무가 사라진 직후 한 번만 다시 그린다
		if ( this.shadowRefresh >= 0 ) {

			this.shadowRefresh -= dt;
			if ( this.shadowRefresh < 0 ) this.sunLight.shadow.needsUpdate = true;

		}

	}

	// 초기화: 날아간 빌딩과 물건을 모두 제자리로
	reset() {

		for ( const f of this.flying ) f.mesh.removeFromParent();
		this.flying = [];
		this.flyingProps = [];

		for ( const d of Object.values( this.debris ) ) {

			d.setMatrixAt( 0, _zero );
			d.count = 1;
			d.dirty = false;
			d.instanceMatrix.needsUpdate = true;

		}

		for ( const t of this.towers ) {

			if ( ! t.gone ) continue;
			t.gone = false;
			if ( t.box ) t.box.gone = false;
			t.lod.visible = true;

		}

		const dirty = new Set();

		for ( const t of this.props ) {

			if ( ! t.gone ) continue;
			t.gone = false;
			t.mesh.setMatrixAt( t.index, t.local );
			dirty.add( t.mesh );

		}

		for ( const mesh of dirty ) mesh.instanceMatrix.needsUpdate = true;
		this.tilesGroup.needsUpdate = true;
		this.sunLight.shadow.needsUpdate = true;
		this.events.length = 0;

	}

	get destroyed() {

		return this.towers.filter( ( t ) => t.gone ).length;

	}

}

const _zero = new THREE.Matrix4().makeScale( 0, 0, 0 );
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3( 0, 1, 0 );
