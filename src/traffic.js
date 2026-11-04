import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ASSETS } from './character.js';

// webgl_materials_car 의 페라리 458 이 서울 도로를 우측통행으로 달린다.
// 차선 4개 (중앙선 기준 안쪽 2.75m, 바깥쪽 8.25m), 교차로 신호, 앞차 간격 유지, 좌·우회전.

const LANES = [ 2.75, 8.25 ];
const CYCLE = 22; // 신호 주기 (초)
const STOP = 17.2; // 교차로 중심에서 정지선까지
const HALF_LEN = 2.3;

const UP = new THREE.Vector3( 0, 1, 0 );

export class Traffic {

	constructor( scene, world, sound, options = {} ) {

		this.scene = scene;
		this.world = world;
		this.sound = sound;
		this.count = options.count ?? 40;
		this.maxI = options.maxI ?? 1; // 차가 다니는 범위 (도로 번호)
		this.maxJ = options.maxJ ?? 2;
		this.cars = [];
		this.time = 0;
		this.events = [];
		this.lightLevel = uniform( 0 );

	}

	async load() {

		const draco = new DRACOLoader();
		draco.setDecoderPath( 'https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/libs/draco/gltf/' );
		const loader = new GLTFLoader();
		loader.setDRACOLoader( draco );

		const [ gltf, aoTexture ] = await Promise.all( [
			loader.loadAsync( ASSETS + 'models/gltf/ferrari.glb' ),
			new THREE.TextureLoader().loadAsync( ASSETS + 'models/gltf/ferrari_ao.png' )
		] );

		const template = gltf.scene.children[ 0 ];

		// 검은색 / 흰색 차체
		this.bodyMaterials = {
			black: new THREE.MeshPhysicalMaterial( { color: 0x060607, metalness: 0.9, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03 } ),
			white: new THREE.MeshPhysicalMaterial( { color: 0xf4f4f2, metalness: 0.25, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.03 } )
		};
		const details = new THREE.MeshStandardMaterial( { color: 0xffffff, metalness: 1.0, roughness: 0.5 } );
		const glass = new THREE.MeshPhysicalMaterial( { color: 0xffffff, metalness: 0.25, roughness: 0, transmission: 1.0 } );

		for ( const name of [ 'rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim' ] ) template.getObjectByName( name ).material = details;
		template.getObjectByName( 'glass' ).material = glass;

		// 모델이 어느 쪽을 보는지: 앞바퀴가 뒷바퀴보다 +z 면 +z 가 앞
		const front = template.getObjectByName( 'wheel_fl' ).position.z;
		const rear = template.getObjectByName( 'wheel_rl' ).position.z;
		this.modelForward = Math.sign( front - rear ) || 1;

		const box = new THREE.Box3().setFromObject( template );
		this.length = box.max.z - box.min.z;
		this.wheelRadius = 0.34;

		// 바닥 그림자 (예제와 같은 AO 텍스처)
		const shadowMaterial = new THREE.MeshBasicMaterial( { map: aoTexture, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true, depthWrite: false } );
		const shadowGeometry = new THREE.PlaneGeometry( 0.655 * 4, 1.3 * 4 ).rotateX( - Math.PI / 2 );

		// 전조등 / 후미등 (저녁엔 빛난다)
		const headMat = new THREE.MeshBasicNodeMaterial();
		headMat.colorNode = color( 1.0, 0.93, 0.8 ).mul( this.lightLevel.mul( 40 ).add( 1.2 ) );
		const tailMat = new THREE.MeshBasicNodeMaterial();
		tailMat.colorNode = color( 1.0, 0.03, 0.02 ).mul( this.lightLevel.mul( 22 ).add( 1.0 ) );
		const lampGeometry = new THREE.BoxGeometry( 0.34, 0.07, 0.04 );
		const zFront = this.modelForward > 0 ? box.max.z - 0.42 : box.min.z + 0.42;
		const zRear = this.modelForward > 0 ? box.min.z + 0.12 : box.max.z - 0.12;

		for ( let i = 0; i < this.count; i ++ ) {

			const model = template.clone();
			const white = Math.random() < 0.5;
			model.getObjectByName( 'body' ).material = white ? this.bodyMaterials.white : this.bodyMaterials.black;

			const wheels = [ 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr' ].map( ( n ) => model.getObjectByName( n ) );

			const shadow = new THREE.Mesh( shadowGeometry, shadowMaterial );
			shadow.position.y = 0.01;
			shadow.renderOrder = 2;
			model.add( shadow );

			for ( const x of [ - 0.62, 0.62 ] ) {

				const h = new THREE.Mesh( lampGeometry, headMat );
				h.position.set( x, 0.66, zFront );
				model.add( h );
				const t = new THREE.Mesh( lampGeometry, tailMat );
				t.position.set( x, 0.8, zRear );
				model.add( t );

			}

			model.traverse( ( o ) => {

				if ( o.isMesh ) o.receiveShadow = true;

			} );

			// 차 몸체는 무게중심에서 돈다 (날아갈 때)
			const root = new THREE.Group();
			model.position.y = - 0.5;
			if ( this.modelForward < 0 ) model.rotation.y = Math.PI;
			root.add( model );
			this.scene.add( root );

			const car = {
				root, model, wheels, white,
				pos: new THREE.Vector3(), heading: new THREE.Vector3( 0, 0, 1 ),
				speed: 0, maxSpeed: 9 + Math.random() * 6,
				mode: 'lane', axis: 'z', dir: 1, line: 0, laneOff: LANES[ 0 ], nextIdx: 0,
				maneuver: null, turn: null,
				vel: new THREE.Vector3(), spin: new THREE.Vector3(), wreckTime: 0,
				honkCooldown: 0, wobble: 0, stuck: 0, ghost: 0
			};

			this.spawn( car, null );
			this.cars.push( car );

		}

	}

	// ---- 도로 좌표 도우미

	period( axis ) {

		return axis === 'z' ? this.world.periodZ : this.world.periodX;

	}

	maxIndex( axis ) {

		return axis === 'z' ? this.maxJ : this.maxI;

	}

	lanePosition( car, s, target = new THREE.Vector3() ) {

		// axis z: x = line·Px - dir·L / axis x: z = line·Pz + dir·L (우측통행)
		if ( car.axis === 'z' ) return target.set( car.line * this.world.periodX - car.dir * car.laneOff, 0.5, s );
		return target.set( s, 0.5, car.line * this.world.periodZ + car.dir * car.laneOff );

	}

	along( car ) {

		return car.axis === 'z' ? car.pos.z : car.pos.x;

	}

	spawn( car, avoid ) {

		for ( let tries = 0; tries < 60; tries ++ ) {

			const axis = Math.random() < 0.5 ? 'z' : 'x';
			const P = this.period( axis );
			const line = Math.round( ( Math.random() * 2 - 1 ) * ( axis === 'z' ? this.maxI : this.maxJ ) );
			const max = this.maxIndex( axis );
			const seg = Math.floor( Math.random() * ( 2 * max ) ) - max; // 교차로 seg 와 seg+1 사이
			const s = ( seg + 0.25 + Math.random() * 0.5 ) * P;

			car.axis = axis;
			car.line = line;
			car.dir = Math.random() < 0.5 ? 1 : - 1;
			car.laneOff = LANES[ Math.random() < 0.5 ? 0 : 1 ];
			this.lanePosition( car, s, car.pos );

			if ( avoid && car.pos.distanceTo( avoid ) < 70 ) continue;
			if ( this.cars.some( ( c ) => c !== car && c.pos.distanceTo( car.pos ) < 12 ) ) continue;
			break;

		}

		car.heading.set( car.axis === 'x' ? car.dir : 0, 0, car.axis === 'z' ? car.dir : 0 );
		car.mode = 'lane';
		car.turn = null;
		car.maneuver = null;
		car.speed = car.maxSpeed * 0.6;
		car.nextIdx = this.nextIndex( car );
		car.root.scale.setScalar( 1 );
		car.root.visible = true;
		car.root.rotation.set( 0, Math.atan2( car.heading.x, car.heading.z ), 0 );
		car.root.position.copy( car.pos );

	}

	nextIndex( car ) {

		const P = this.period( car.axis );
		const s = this.along( car );
		return car.dir > 0 ? Math.floor( s / P + 1e-6 ) + 1 : Math.ceil( s / P - 1e-6 ) - 1;

	}

	// 교차로 (i, j) 에서 이 축이 초록불인가
	signal( axis, i, j ) {

		const t = ( this.time + ( i * 5 + j * 3 ) * 1.7 ) % CYCLE;
		const half = CYCLE / 2;
		const phase = axis === 'z' ? t : ( t + half ) % CYCLE;
		if ( phase < half - 2.5 ) return 'green';
		if ( phase < half ) return 'amber';
		return 'red';

	}

	chooseManeuver( car ) {

		const options = [];
		const max = this.maxIndex( car.axis );
		if ( Math.abs( car.nextIdx + car.dir ) <= max ) options.push( 'straight', 'straight', 'straight' );

		for ( const m of [ 'right', 'left' ] ) {

			const d2 = this.turnDirection( car.heading, m );
			const axis2 = Math.abs( d2.x ) > 0.5 ? 'x' : 'z';
			const dir2 = Math.sign( axis2 === 'x' ? d2.x : d2.z );
			const here = car.line; // 지금 달리는 도로가 새 축에서의 위치 번호
			if ( Math.abs( here + dir2 ) <= this.maxIndex( axis2 ) ) options.push( m );

		}

		return options[ Math.floor( Math.random() * options.length ) ] || 'right';

	}

	turnDirection( d1, maneuver ) {

		// 오른쪽 = d × up = (-dz, 0, dx)
		return maneuver === 'right' ? new THREE.Vector3( - d1.z, 0, d1.x ) : new THREE.Vector3( d1.z, 0, - d1.x );

	}

	prepareTurn( car ) {

		const d1 = car.heading.clone();
		const d2 = this.turnDirection( d1, car.maneuver );
		const axis2 = Math.abs( d2.x ) > 0.5 ? 'x' : 'z';
		const dir2 = Math.sign( axis2 === 'x' ? d2.x : d2.z );
		const L1 = car.laneOff, L2 = car.laneOff;

		// 교차로 중심
		const cx = car.axis === 'z' ? car.line * this.world.periodX : car.nextIdx * this.world.periodX;
		const cz = car.axis === 'z' ? car.nextIdx * this.world.periodZ : car.line * this.world.periodZ;

		// 들어오는 차선과 나가는 차선이 만나는 점
		const C = new THREE.Vector3();
		if ( car.axis === 'z' ) C.set( cx - car.dir * L1, 0.5, cz + dir2 * L2 );
		else C.set( cx - dir2 * L2, 0.5, cz + car.dir * L1 );

		const inner = L1 < 5;
		const R = car.maneuver === 'right' ? ( inner ? 7 : 5 ) : ( inner ? 9 : 14 );
		const S = C.clone().addScaledVector( d1, - R );
		const O = S.clone().addScaledVector( d2, R );

		car.turn = { d1, d2, R, O, S, theta: 0, axis2, dir2, line2: car.nextIdx, started: false };

	}

	// ------------------------------------------------------------------

	update( dt, me, fart ) {

		this.time += dt;
		const cars = this.cars;

		for ( const car of cars ) {

			car.honkCooldown -= dt;

			if ( car.mode === 'fly' ) {

				this.updateFlying( car, dt, me );
				continue;

			}

			if ( car.mode === 'player' ) continue; // 내가 운전 중 (drive() 에서 움직인다)

			if ( car.mode === 'parked' ) {

				// 내가 내린 차: 한동안 서 있다가 멀어지면 다른 데서 다시 달린다
				car.parkTime += dt;
				if ( car.parkTime > 25 && car.pos.distanceTo( me.position ) > 80 ) this.spawn( car, me.position );
				continue;

			}

			if ( car.mode === 'wreck' ) {

				car.wreckTime += dt;
				if ( car.wreckTime > 7 ) {

					const s = Math.max( 0, 1 - ( car.wreckTime - 7 ) * 2 );
					car.root.scale.setScalar( s );
					if ( s <= 0 ) this.spawn( car, me.position );

				}

				continue;

			}

			// ---- 앞 장애물 (다른 차, 나)
			let gap = 60;
			let blockedByMe = false;

			for ( const other of cars ) {

				if ( other === car ) continue;
				const rx = other.pos.x - car.pos.x, rz = other.pos.z - car.pos.z;
				const ahead = rx * car.heading.x + rz * car.heading.z;
				if ( ahead <= 0 || ahead > 40 ) continue;
				const lateral = Math.abs( rx * car.heading.z - rz * car.heading.x );
				if ( lateral < 2.1 ) gap = Math.min( gap, ahead - this.length );

			}

			{

				const rx = me.position.x - car.pos.x, rz = me.position.z - car.pos.z;
				const ahead = rx * car.heading.x + rz * car.heading.z;
				const lateral = Math.abs( rx * car.heading.z - rz * car.heading.x );

				if ( ahead > 0 && ahead < 30 && lateral < 2.2 && me.position.y < 3 ) {

					if ( ahead - HALF_LEN - ( this.player ? 1.6 : 0 ) < gap ) {

						gap = ahead - HALF_LEN;
						blockedByMe = true;

					}

				}

			}

			// 교차로에서 서로 마주 보고 멈춰 버리면 잠깐 양보 없이 지나간다
			if ( car.ghost > 0 ) {

				car.ghost -= dt;
				if ( ! blockedByMe ) gap = 60;

			}

			let desired = car.maxSpeed;
			desired = Math.min( desired, Math.max( 0, gap - 4 ) * 1.1 );

			if ( car.speed < 0.3 && gap < 12 && ! blockedByMe ) car.stuck += dt;
			else car.stuck = 0;

			if ( car.stuck > 5 ) {

				car.stuck = 0;
				car.ghost = 2.5;

			}

			if ( blockedByMe && gap < 18 && car.honkCooldown < 0 ) {

				car.honkCooldown = 3 + Math.random() * 2;
				this.sound.honk( car.pos.distanceTo( me.position ) );
				this.events.push( { type: 'honk', pos: car.pos.clone() } );

			}

			if ( car.mode === 'lane' ) this.updateLane( car, dt, desired );
			else this.updateTurn( car, dt, desired );

			// 바퀴 굴리기
			const roll = car.speed * dt / this.wheelRadius * this.modelForward;
			for ( const w of car.wheels ) w.rotation.x += roll;

			// 방구 맞고 휘청
			car.wobble *= Math.max( 0, 1 - dt * 3 );
			const wob = Math.sin( this.time * 25 ) * car.wobble * 0.12;

			car.root.position.copy( car.pos );
			car.root.rotation.set( 0, Math.atan2( car.heading.x, car.heading.z ), wob );

		}

		if ( fart.active ) this.blast( dt, me, fart );

	}

	updateLane( car, dt, desired ) {

		const P = this.period( car.axis );
		const s = this.along( car );
		const center = car.nextIdx * P;
		const dist = ( center - s ) * car.dir; // 다음 교차로 중심까지

		if ( car.maneuver === null && dist < 45 ) {

			car.maneuver = this.chooseManeuver( car );
			if ( car.maneuver !== 'straight' ) this.prepareTurn( car );

		}

		// 신호: 정지선 전이면 빨간불/주황불에 선다
		const front = dist - HALF_LEN;

		if ( front > STOP - 0.5 ) {

			const i = car.axis === 'z' ? car.line : car.nextIdx;
			const j = car.axis === 'z' ? car.nextIdx : car.line;
			const light = this.signal( car.axis, i, j );
			const toStop = front - STOP;

			if ( light === 'red' || ( light === 'amber' && toStop > 6 ) ) {

				desired = Math.min( desired, Math.sqrt( 2 * 4.5 * Math.max( 0, toStop - 0.3 ) ) );

			}

		}

		if ( car.maneuver && car.maneuver !== 'straight' ) desired = Math.min( desired, Math.max( 6, dist * 0.5 ) );

		this.accelerate( car, dt, desired );

		const ns = s + car.dir * car.speed * dt;
		this.lanePosition( car, ns, car.pos );

		// 회전 시작점에 도달
		if ( car.turn ) {

			const sAlong = car.axis === 'z' ? car.turn.S.z : car.turn.S.x;

			if ( ( ns - sAlong ) * car.dir >= 0 ) {

				car.mode = 'turn';
				car.pos.copy( car.turn.S );

			}

		} else if ( dist < - 12 ) {

			car.nextIdx += car.dir;
			car.maneuver = null;

		}

	}

	updateTurn( car, dt, desired ) {

		const t = car.turn;
		this.accelerate( car, dt, Math.min( desired, 6.5 ) );
		t.theta = Math.min( Math.PI / 2, t.theta + car.speed * dt / t.R );

		const c = Math.cos( t.theta ), s = Math.sin( t.theta );
		car.pos.copy( t.O ).addScaledVector( t.d2, - t.R * c ).addScaledVector( t.d1, t.R * s );
		car.heading.copy( t.d1 ).multiplyScalar( c ).addScaledVector( t.d2, s ).normalize();

		if ( t.theta >= Math.PI / 2 ) {

			car.axis = t.axis2;
			car.dir = t.dir2;
			car.line = t.line2;
			car.heading.copy( t.d2 );
			car.mode = 'lane';
			car.turn = null;
			car.maneuver = null;
			car.nextIdx = this.nextIndex( car );

		}

	}

	accelerate( car, dt, desired ) {

		if ( desired > car.speed ) car.speed = Math.min( desired, car.speed + 3.2 * dt );
		else car.speed = Math.max( desired, car.speed - 9 * dt );

	}

	// ---- 방구 바람
	blast( dt, me, fart ) {

		const p = fart.physics;
		const origin = me.jetOrigin;
		const dir = me.jetDirection;
		const reach = p.reach;
		let launched = 0;

		for ( const car of this.cars ) {

			if ( car.mode === 'fly' || car.mode === 'wreck' || car.mode === 'player' ) continue;

			const rel = car.pos.clone().sub( origin );
			const dist = rel.length();
			if ( dist > reach ) continue;

			const along = rel.dot( dir );
			const inCone = along > 0 && along / Math.max( dist, 0.001 ) > 0.55;
			const near = dist < reach * 0.4;
			if ( ! inCone && ! near ) continue;

			const strength = p.force * ( 1 - dist / reach );

			// 페라리는 사람·물건보다 무거워서 더 센 방구여야 날아간다
			if ( strength > 300 ) {

				const push = rel.clone().setY( 0 ).normalize();
				if ( inCone ) push.lerp( new THREE.Vector3( dir.x, 0, dir.z ).normalize(), 0.6 ).normalize();
				this.launch( car, push, strength );
				launched ++;

			} else {

				// 약한 방구: 깜짝 놀라 급정거하고 휘청
				car.speed = Math.max( 0, car.speed - 30 * dt );
				car.wobble = Math.max( car.wobble, Math.min( 1, strength / 80 ) );

				if ( car.honkCooldown < 0 ) {

					car.honkCooldown = 4;
					this.sound.honk( dist );
					this.events.push( { type: 'honk', pos: car.pos.clone() } );

				}

			}

		}

		if ( launched ) this.events.push( { type: 'launch', count: launched } );

	}

	// 첫 순간의 충격파
	shock( center, force, radius ) {

		let launched = 0;

		for ( const car of this.cars ) {

			if ( car.mode === 'fly' || car.mode === 'wreck' || car.mode === 'player' ) continue;
			const rel = car.pos.clone().sub( center );
			const dist = rel.length();
			if ( dist > radius ) continue;
			const strength = force * ( 1 - dist / radius ) * 0.8;

			if ( strength > 330 ) {

				this.launch( car, rel.setY( 0 ).normalize(), strength );
				launched ++;

			} else car.wobble = 1;

		}

		if ( launched ) this.events.push( { type: 'launch', count: launched } );

	}

	// 초기화: 모든 차를 처음처럼 도로에 다시 놓는다
	reset() {

		this.player = null;
		this.time = 0;
		for ( const car of this.cars ) car.pos.set( 1e5, 0, 1e5 );
		for ( const car of this.cars ) {

			car.root.quaternion.identity();
			car.wobble = 0;
			car.stuck = 0;
			car.ghost = 0;
			this.spawn( car, null );

		}

	}

	// ------------------------------------------------------------------
	// 내가 페라리를 탄다

	nearestCar( pos, maxDist = 4.5 ) {

		let best = null, bestD = maxDist;

		for ( const car of this.cars ) {

			if ( car.mode === 'fly' || car.mode === 'player' || ! car.root.visible ) continue;
			const d = Math.hypot( car.pos.x - pos.x, car.pos.z - pos.z );
			if ( d < bestD && Math.abs( car.pos.y - 0.5 - pos.y ) < 1.5 ) {

				bestD = d;
				best = car;

			}

		}

		return best;

	}

	enter( car ) {

		// 뒤집힌 차면 바로 세운다
		car.mode = 'player';
		car.steer = 0;
		car.wobble = 0;
		car.root.scale.setScalar( 1 );
		car.pos.y = this.world.heightAt( car.pos.x, car.pos.z ) + 0.5;
		const fwd = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( car.root.quaternion ).setY( 0 );
		if ( fwd.lengthSq() < 0.01 ) fwd.copy( car.heading );
		car.heading.copy( fwd.normalize() );
		this.player = car;
		return car;

	}

	exit() {

		const car = this.player;
		if ( ! car ) return null;
		car.mode = 'parked';
		car.parkTime = 0;
		car.speed = 0;
		this.player = null;
		return car;

	}

	// 운전석 왼쪽 문 앞 (내릴 때 서는 자리)
	doorSide( car, target = new THREE.Vector3() ) {

		const left = new THREE.Vector3( car.heading.z, 0, - car.heading.x );
		return target.copy( car.pos ).addScaledVector( left, 1.6 ).setY( this.world.heightAt( car.pos.x + left.x * 1.6, car.pos.z + left.z * 1.6 ) );

	}

	drive( dt, input, fart, me ) {

		const car = this.player;
		if ( ! car ) return;

		const max = fart.active ? 60 : 36;
		let a = 0;
		if ( input.forward > 0 ) a = 11 * input.forward;
		else if ( input.forward < 0 ) a = car.speed > 0.5 ? - 18 : - 6;
		else a = - Math.sign( car.speed ) * Math.min( Math.abs( car.speed ) / dt, 2.5 );

		// 방구 부스터: 배기구로 뀐다
		if ( fart.active ) a += fart.physics.force / 40;

		car.speed = THREE.MathUtils.clamp( car.speed + a * dt, - 8, max );

		const steerMax = 0.55 / ( 1 + Math.abs( car.speed ) * 0.04 );
		car.steer += ( - input.turn * steerMax - car.steer ) * Math.min( 1, dt * 6 );
		const yawRate = car.speed * Math.tan( car.steer ) / 2.65;
		car.heading.applyAxisAngle( UP, yawRate * dt ).normalize();

		const next = car.pos.clone().addScaledVector( car.heading, car.speed * dt );
		const nose = next.clone().addScaledVector( car.heading, Math.sign( car.speed || 1 ) * 2.1 );
		const ground = this.world.heightAt( nose.x, nose.z );

		if ( ground > car.pos.y + 0.2 ) {

			// 건물에 쾅
			if ( Math.abs( car.speed ) > 5 ) {

				this.sound.thud( Math.min( 1, Math.abs( car.speed ) / 25 ), 0 );
				this.events.push( { type: 'crash', speed: Math.abs( car.speed ) } );

			}

			car.speed *= - 0.25;

		} else {

			car.pos.copy( next );

		}

		car.pos.y += ( this.world.heightAt( car.pos.x, car.pos.z ) + 0.5 - car.pos.y ) * Math.min( 1, dt * 12 );

		// 다른 차를 들이받으면 날려 버린다
		for ( const other of this.cars ) {

			if ( other === car || other.mode === 'fly' || other.mode === 'wreck' ) continue;
			const d = other.pos.distanceTo( car.pos );

			if ( d < 3.4 ) {

				const push = other.pos.clone().sub( car.pos ).setY( 0 ).normalize();

				if ( Math.abs( car.speed ) > 7 ) {

					this.launch( other, push.lerp( car.heading, 0.5 ).normalize(), Math.abs( car.speed ) * 22 );
					this.events.push( { type: 'launch', count: 1 } );
					this.sound.thud( 1, 0 );
					car.speed *= 0.75;

				} else {

					car.speed *= 0.5;
					car.pos.addScaledVector( push, - ( 3.4 - d ) * 0.5 );

				}

			}

		}

		const roll = car.speed * dt / this.wheelRadius * this.modelForward;
		for ( const w of car.wheels ) w.rotation.x += roll;

		car.root.position.copy( car.pos );
		car.root.rotation.set( 0, Math.atan2( car.heading.x, car.heading.z ), 0 );

		// 방구는 배기구(차 뒤)에서 나온다
		me.position.copy( car.pos ).setY( car.pos.y - 0.5 );
		me.jetOrigin.copy( car.pos ).addScaledVector( car.heading, - 2.3 ).setY( car.pos.y - 0.05 );
		me.jetDirection.copy( car.heading ).negate().setY( - 0.15 ).normalize();

	}

	launch( car, direction, strength ) {

		car.mode = 'fly';
		car.vel.copy( direction ).multiplyScalar( 4 + strength / 45 );
		car.vel.y = 3 + strength / 70 + Math.random() * 3;
		car.vel.addScaledVector( car.heading, car.speed * 0.5 );
		car.spin.set( ( Math.random() - 0.5 ) * 6, ( Math.random() - 0.5 ) * 4, ( Math.random() - 0.5 ) * 6 ).multiplyScalar( 0.5 + strength / 600 );
		car.bounces = 0;

	}

	updateFlying( car, dt, me ) {

		car.vel.y -= 9.81 * dt;
		car.pos.addScaledVector( car.vel, dt );

		// 건물 벽에 튕김
		const top = this.world.heightAt( car.pos.x, car.pos.z );
		if ( top > 2 && car.pos.y < top ) {

			car.pos.x -= car.vel.x * dt * 2;
			car.pos.z -= car.vel.z * dt * 2;
			car.vel.x *= - 0.4;
			car.vel.z *= - 0.4;

		}

		const q = new THREE.Quaternion().setFromEuler( new THREE.Euler( car.spin.x * dt, car.spin.y * dt, car.spin.z * dt ) );
		car.root.quaternion.premultiply( q );

		const floor = this.world.heightAt( car.pos.x, car.pos.z ) + 0.5;

		if ( car.pos.y < floor ) {

			car.pos.y = floor;
			const impact = - car.vel.y;
			car.vel.y = impact * 0.35;
			car.vel.x *= 0.55;
			car.vel.z *= 0.55;
			car.spin.multiplyScalar( 0.5 );
			car.bounces ++;
			if ( impact > 3 ) this.sound.thud( Math.min( 1, impact / 12 ), car.pos.distanceTo( me.position ) );

			if ( car.vel.length() < 1.5 || car.bounces > 4 ) {

				car.mode = 'wreck';
				car.wreckTime = 0;

				// 바퀴가 위든 아래든 가까운 쪽으로 눕힌다
				const up = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( car.root.quaternion );
				const fwd = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( car.root.quaternion ).setY( 0 ).normalize();
				const q2 = new THREE.Quaternion().setFromUnitVectors( new THREE.Vector3( 0, 0, 1 ), fwd.lengthSq() > 0.1 ? fwd : new THREE.Vector3( 0, 0, 1 ) );
				if ( up.y < 0 ) q2.multiply( new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 0, 1 ), Math.PI ) );
				car.root.quaternion.copy( q2 );
				car.pos.y = floor + ( up.y < 0 ? 0.25 : 0 );

			}

		}

		car.root.position.copy( car.pos );

	}

}
