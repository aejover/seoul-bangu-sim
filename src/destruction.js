import * as THREE from 'three/webgpu';

// 아주 센 방구는 가로수를 뽑고, 더 세면 빌딩까지 날려 버린다.
// 원래 자리의 빌딩/나무는 숨기고, 똑같이 생긴 조각을 따로 만들어 던진다.

const TREE_THRESHOLD = 150; // 나무가 뽑히는 세기 (N)
const TOWER_THRESHOLD = 480; // 빌딩이 날아가는 세기 (N)

export class Destruction {

	constructor( scene, tilesGroup, world, sunLight, sound ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.world = world;
		this.sunLight = sunLight;
		this.sound = sound;
		this.towers = [];
		this.trees = [];
		this.flying = [];
		this.flyingTrees = [];
		this.events = [];
		this.shadowTimer = 0;
		this.pulse = 0;

		this.index();

	}

	index() {

		this.scene.updateMatrixWorld( true );
		const boxes = new Map();
		for ( const b of this.world.towers ) boxes.set( `${ Math.round( b.cx ) },${ Math.round( b.cz ) }`, b );

		const p = new THREE.Vector3();
		const m = new THREE.Matrix4();
		let treeSource = null;

		for ( const tile of this.tilesGroup.children ) {

			tile.traverse( ( o ) => {

				if ( o.isLOD ) {

					o.getWorldPosition( p );
					let box = null;

					for ( let dx = - 1; dx <= 1 && ! box; dx ++ ) {

						for ( let dz = - 1; dz <= 1 && ! box; dz ++ ) box = boxes.get( `${ Math.round( p.x ) + dx },${ Math.round( p.z ) + dz }` ) || null;

					}

					this.towers.push( { lod: o, mesh: o.levels[ 0 ].object, box, center: p.clone(), gone: false } );

				} else if ( o.name === 'StreetTrees' && o.isInstancedMesh ) {

					treeSource = treeSource || o;

					for ( let i = 0; i < o.count; i ++ ) {

						o.getMatrixAt( i, m );
						m.premultiply( o.matrixWorld );
						p.setFromMatrixPosition( m );
						if ( m.elements[ 0 ] === 0 && m.elements[ 5 ] === 0 ) continue;
						this.trees.push( { mesh: o, index: i, pos: p.clone(), matrix: m.clone(), gone: false } );

					}

				}

			} );

		}

		// 날아가는 나무는 인스턴스 하나에 모아서 그린다
		if ( treeSource ) {

			this.treeDebris = new THREE.InstancedMesh( treeSource.geometry, treeSource.material, 240 );
			this.treeDebris.count = 0;
			this.treeDebris.frustumCulled = false;
			this.treeDebris.castShadow = true;
			this.scene.add( this.treeDebris );

		}

		// 근처만 빨리 찾도록 격자에 넣는다
		this.cell = 40;
		this.grid = new Map();
		const add = ( key, item ) => {

			if ( ! this.grid.has( key ) ) this.grid.set( key, { towers: [], trees: [] } );
			return this.grid.get( key );

		};

		for ( const t of this.towers ) add( this.key( t.center.x, t.center.z ) ).towers.push( t );
		for ( const t of this.trees ) add( this.key( t.pos.x, t.pos.z ) ).trees.push( t );

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

	// 충격파: 반경 안에서 세기가 문턱을 넘는 것은 날아간다
	shock( center, force, radius ) {

		let trees = 0, towers = 0;

		this.near( center, radius, ( cell ) => {

			for ( const t of cell.trees ) {

				if ( t.gone ) continue;
				const d = Math.hypot( t.pos.x - center.x, t.pos.z - center.z );
				if ( d > radius ) continue;
				const strength = force * ( 1 - d / radius );
				if ( strength > TREE_THRESHOLD ) {

					this.throwTree( t, center, strength );
					trees ++;

				}

			}

			for ( const t of cell.towers ) {

				if ( t.gone || ! t.box ) continue;
				// 빌딩은 벽까지의 거리로 잰다
				const b = t.box;
				const ex = Math.max( b.x0 - center.x, 0, center.x - b.x1 );
				const ez = Math.max( b.z0 - center.z, 0, center.z - b.z1 );
				const d = Math.hypot( ex, ez );
				if ( d > radius ) continue;
				const strength = force * ( 1 - d / radius );
				if ( strength > TOWER_THRESHOLD ) {

					this.throwTower( t, center, strength );
					towers ++;

				}

			}

		} );

		if ( trees || towers ) {

			this.tilesGroup.needsUpdate = true;
			this.events.push( { type: 'destroy', trees, towers } );
			if ( towers ) this.sound.boom( Math.min( 1, towers / 3 + 0.4 ) );

		}

	}

	throwTree( t, center, strength ) {

		t.gone = true;
		const zero = new THREE.Matrix4().makeScale( 0, 0, 0 );
		t.mesh.setMatrixAt( t.index, zero );
		t.mesh.instanceMatrix.needsUpdate = true;

		if ( ! this.treeDebris || this.flyingTrees.length >= 240 ) return;

		const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
		t.matrix.decompose( pos, quat, scale );
		const dir = pos.clone().sub( center ).setY( 0 ).normalize();
		this.flyingTrees.push( {
			pos, quat, scale,
			vel: dir.multiplyScalar( 4 + strength / 30 ).setY( 5 + strength / 50 + Math.random() * 4 ),
			spin: new THREE.Vector3( Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5 ).multiplyScalar( 8 ),
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
		const inner = new THREE.Mesh( geometry, t.mesh.material );
		inner.position.y = - ( bb.min.y + half );
		inner.castShadow = true;
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
	blast( dt, origin, physics ) {

		this.pulse -= dt;
		if ( this.pulse > 0 || physics.force < TREE_THRESHOLD * 1.2 ) return;
		this.pulse = 0.5;
		this.shock( origin, physics.force * 0.85, physics.reach * 0.9 );

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
			q.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), f.twist * dt );
			f.mesh.quaternion.premultiply( q );

			// 쓰러지듯 땅에 닿으면 튀었다가 땅속으로 가라앉는다
			const up = Math.abs( new THREE.Vector3( 0, 1, 0 ).applyQuaternion( f.mesh.quaternion ).y );
			const lowest = f.mesh.position.y - f.height * 0.5 * up - f.width * 0.5 * Math.sqrt( 1 - up * up );

			if ( lowest < 0 && f.vel.y < 0 ) {

				f.bounces ++;
				f.vel.y *= - 0.25;
				f.vel.x *= 0.5;
				f.vel.z *= 0.5;
				f.spin *= 0.5;
				this.events.push( { type: 'impact', pos: f.mesh.position.clone(), strength: 1 } );
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

		// 나무
		const m = new THREE.Matrix4();
		const e = new THREE.Euler();

		for ( const t of this.flyingTrees ) {

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
					// 옆으로 누운 채 멈춘다
					const yaw = Math.random() * Math.PI * 2;
					t.quat.setFromEuler( e.set( Math.PI / 2 * 0.92, yaw, 0, 'YXZ' ) );

				}

			} else if ( t.age > 12 ) {

				t.scale.multiplyScalar( Math.max( 0, 1 - dt * 2 ) );

			}

		}

		this.flyingTrees = this.flyingTrees.filter( ( t ) => t.scale.x > 0.02 );

		if ( this.treeDebris ) {

			this.treeDebris.count = this.flyingTrees.length;
			this.flyingTrees.forEach( ( t, i ) => this.treeDebris.setMatrixAt( i, m.compose( t.pos, t.quat, t.scale ) ) );
			this.treeDebris.instanceMatrix.needsUpdate = true;

		}

		// 그림자는 무언가 날아다닐 때만 가끔 다시 그린다
		this.shadowTimer -= dt;

		if ( ( this.flying.length || this.flyingTrees.some( ( t ) => ! t.landed ) ) && this.shadowTimer < 0 ) {

			this.shadowTimer = 0.25;
			this.sunLight.shadow.needsUpdate = true;

		}

	}

	get destroyed() {

		return this.towers.filter( ( t ) => t.gone ).length;

	}

}
