import * as THREE from 'three/webgpu';
import { walkPose, limb, lerpV, blobShadowTexture } from './rig.js';
import { FaceKit, Face, HAIR_STYLES, SKIN_TONES } from './face.js';
import { loadSoldier, SoldierBody, dressedGeometry, addProps, OUTFITS, ALL } from './soldier.js';
import { LIFTOFF_FORCE } from './fart.js';

// 서울 인도를 걷는 사람들과 자전거 타는 사람들.
// 몸은 Soldier (걷기·달리기 애니메이션) + 사진 속 옷차림, 얼굴은 Lee Perry-Smith 스캔. 내 방구에 반응한다.

const HAND_SKIN = [ 0xedc9a8, 0xe5bc98, 0xd9ac85, 0xc99a72 ];
const BIKE_COLORS = [ 0xdfe3e0, 0xdfe3e0, 0xc62828, 0x1e88e5, 0x212121, 0xf9a825 ];
const NONE = { hips: 0, spine: 0, head: 0, armL: 0, armR: 0, legs: 0 };

const pick = ( a ) => a[ Math.floor( Math.random() * a.length ) ];
const mod = ( a, n ) => ( ( a % n ) + n ) % n;
const angleTo = ( a ) => Math.atan2( Math.sin( a ), Math.cos( a ) );

// ---------------------------------------------------------------------------
// 블록 둘레 인도 (사각형 고리)

class Ring {

	constructor( x0, z0, x1, z1 ) {

		this.x0 = x0; this.z0 = z0; this.x1 = x1; this.z1 = z1;
		this.w = x1 - x0;
		this.h = z1 - z0;
		this.L = 2 * ( this.w + this.h );

	}

	at( s, p, t ) {

		const { x0, z0, x1, z1, w, h } = this;
		s = mod( s, this.L );
		if ( s < w ) { p.set( x0 + s, 0, z0 ); t.set( 1, 0, 0 ); }
		else if ( s < w + h ) { p.set( x1, 0, z0 + s - w ); t.set( 0, 0, 1 ); }
		else if ( s < 2 * w + h ) { p.set( x1 - ( s - w - h ), 0, z1 ); t.set( - 1, 0, 0 ); }
		else { p.set( x0, 0, z1 - ( s - 2 * w - h ) ); t.set( 0, 0, - 1 ); }

	}

	project( x, z ) {

		const { x0, z0, x1, z1, w, h } = this;
		const cx = THREE.MathUtils.clamp( x, x0, x1 ), cz = THREE.MathUtils.clamp( z, z0, z1 );
		const c = [
			[ Math.abs( z - z0 ) + Math.abs( x - cx ), cx - x0 ],
			[ Math.abs( x - x1 ) + Math.abs( z - cz ), w + cz - z0 ],
			[ Math.abs( z - z1 ) + Math.abs( x - cx ), w + h + x1 - cx ],
			[ Math.abs( x - x0 ) + Math.abs( z - cz ), 2 * w + h + z1 - cz ]
		].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		return c[ 0 ][ 1 ];

	}

}

// ---------------------------------------------------------------------------
// 자전거 (서울 따릉이 같은 생활 자전거)

const BIKE = {
	wheel: 0.34,
	rear: new THREE.Vector3( 0, 0.34, - 0.52 ),
	front: new THREE.Vector3( 0, 0.34, 0.53 ),
	bb: new THREE.Vector3( 0, 0.3, - 0.04 ),
	seat: new THREE.Vector3( 0, 0.93, - 0.3 ),
	bar: new THREE.Vector3( 0, 1.02, 0.4 ),
	crank: 0.17
};

function tube( a, b, r ) {

	const d = b.clone().sub( a );
	const g = new THREE.CylinderGeometry( r, r, d.length(), 6 );
	g.translate( 0, d.length() / 2, 0 );
	g.applyQuaternion( new THREE.Quaternion().setFromUnitVectors( new THREE.Vector3( 0, 1, 0 ), d.normalize() ) );
	g.translate( a.x, a.y, a.z );
	return g;

}

let bikeParts = null;

async function bikeGeometry() {

	if ( bikeParts ) return bikeParts;
	const { mergeGeometries } = await import( 'three/addons/utils/BufferGeometryUtils.js' );
	const v = ( x, y, z ) => new THREE.Vector3( x, y, z );
	const seatTop = v( 0, 0.86, - 0.26 ), headTop = v( 0, 0.88, 0.37 ), headBottom = v( 0, 0.66, 0.42 );
	const frame = mergeGeometries( [
		tube( BIKE.bb, seatTop, 0.02 ),
		tube( seatTop, headTop, 0.018 ),
		tube( BIKE.bb, headBottom, 0.024 ),
		tube( headBottom, headTop, 0.022 ),
		tube( BIKE.bb, v( 0.05, 0.34, - 0.52 ), 0.012 ), tube( BIKE.bb, v( - 0.05, 0.34, - 0.52 ), 0.012 ),
		tube( seatTop, v( 0.05, 0.34, - 0.52 ), 0.011 ), tube( seatTop, v( - 0.05, 0.34, - 0.52 ), 0.011 ),
		tube( headBottom, v( 0.05, 0.34, 0.53 ), 0.014 ), tube( headBottom, v( - 0.05, 0.34, 0.53 ), 0.014 ),
		tube( headTop, BIKE.bar, 0.016 ),
		tube( v( - 0.26, 1.02, 0.36 ), v( 0.26, 1.02, 0.36 ), 0.014 ),
		tube( seatTop, BIKE.seat.clone().add( v( 0, - 0.03, 0.02 ) ), 0.014 )
	] );

	const saddle = new THREE.BoxGeometry( 0.14, 0.05, 0.27 ).translate( 0, BIKE.seat.y, BIKE.seat.z );
	const grips = mergeGeometries( [ tube( v( - 0.3, 1.02, 0.36 ), v( - 0.2, 1.02, 0.36 ), 0.02 ), tube( v( 0.2, 1.02, 0.36 ), v( 0.3, 1.02, 0.36 ), 0.02 ) ] );
	const basket = new THREE.BoxGeometry( 0.36, 0.22, 0.28 ).translate( 0, 0.86, 0.66 );

	// 바퀴: 타이어 + 바퀴살
	const tire = new THREE.TorusGeometry( BIKE.wheel - 0.02, 0.022, 6, 28 ).rotateY( Math.PI / 2 );
	const spokes = [];
	for ( let i = 0; i < 12; i ++ ) {

		const a = i / 12 * Math.PI * 2;
		spokes.push( tube( v( 0, 0, 0 ), v( 0, Math.cos( a ) * 0.31, Math.sin( a ) * 0.31 ), 0.003 ) );

	}

	spokes.push( new THREE.CylinderGeometry( 0.03, 0.03, 0.1, 8 ).rotateZ( Math.PI / 2 ) );
	const wheel = mergeGeometries( [ tire, ...spokes.map( ( g ) => g.toNonIndexed() ) ].map( ( g ) => g.index ? g.toNonIndexed() : g ) );

	// 크랭크 + 페달
	const crank = mergeGeometries( [
		new THREE.BoxGeometry( 0.02, BIKE.crank, 0.025 ).translate( 0.08, - BIKE.crank / 2, 0 ),
		new THREE.BoxGeometry( 0.02, BIKE.crank, 0.025 ).translate( - 0.08, BIKE.crank / 2, 0 ),
		new THREE.BoxGeometry( 0.1, 0.02, 0.07 ).translate( 0.13, - BIKE.crank, 0 ),
		new THREE.BoxGeometry( 0.1, 0.02, 0.07 ).translate( - 0.13, BIKE.crank, 0 ),
		new THREE.CylinderGeometry( 0.09, 0.09, 0.01, 16 ).rotateZ( Math.PI / 2 ).translate( - 0.05, 0, 0 )
	] );

	bikeParts = { frame, saddle, grips, basket, wheel, crank };
	return bikeParts;

}

class Bike {

	constructor( parts, materials, colorIndex ) {

		this.group = new THREE.Group();
		const ddareungi = BIKE_COLORS[ colorIndex ] === 0xdfe3e0;
		const frameMat = materials.frame[ colorIndex ];
		this.group.add( new THREE.Mesh( parts.frame, frameMat ) );
		this.group.add( new THREE.Mesh( parts.saddle, materials.dark ) );
		this.group.add( new THREE.Mesh( parts.grips, materials.dark ) );
		if ( ddareungi ) this.group.add( new THREE.Mesh( parts.basket, materials.green ) );

		this.wheels = [ BIKE.rear, BIKE.front ].map( ( p ) => {

			const w = new THREE.Mesh( parts.wheel, materials.dark );
			w.position.copy( p );
			this.group.add( w );
			return w;

		} );

		this.crank = new THREE.Mesh( parts.crank, materials.metal );
		this.crank.position.copy( BIKE.bb );
		this.group.add( this.crank );

		this.angle = 0; // 크랭크 각
		this.vel = new THREE.Vector3();
		this.spin = new THREE.Vector3();
		this.flying = false;

	}

	roll( distance ) {

		for ( const w of this.wheels ) w.rotation.x += distance / BIKE.wheel;
		this.angle += distance / BIKE.wheel / 2.2;
		this.crank.rotation.x = this.angle;

	}

}

// ---------------------------------------------------------------------------

class Person {

	constructor( people, kind, index ) {

		const female = Math.random() < 0.5;
		this.sex = female ? 'female' : 'male';
		this.kind = kind; // walker | cyclist
		this.index = index;
		const skin = Math.floor( Math.random() * SKIN_TONES.length );
		const outfits = OUTFITS[ this.sex ].filter( ( o ) => kind === 'walker' || ! o.skirt );
		this.outfit = pick( outfits );

		const kit = people.soldier;
		this.body = new SoldierBody( kit, dressedGeometry( kit, this.outfit, this.sex, HAND_SKIN[ skin ] ), people.bodyMaterial );
		this.body.mesh.name = 'Person';
		addProps( this.body, this.outfit );

		this.group = new THREE.Group();
		this.group.add( this.body.root );
		this.scale = female ? 0.92 : 0.97 + Math.random() * 0.06;
		this.group.scale.setScalar( this.scale );

		const styles = HAIR_STYLES[ this.sex ];
		const o = this.outfit;
		this.face = new Face( people.kit, this.sex, {
			skin,
			hairColor: Math.random() < 0.08 ? 5 : Math.floor( Math.random() * 4 ),
			hairStyle: kind === 'cyclist' && female ? 'ponytail' : pick( styles ),
			hat: o.cap ? { kind: 'cap', color: o.cap } : o.beanie ? { kind: 'beanie', color: o.beanie } : null,
			glasses: o.sunglasses ? 'sun' : o.glasses || Math.random() < 0.18 ? 'clear' : null,
			offset: kit.faceOffset
		} );
		this.body.attach( 'Head', kit.joints.head ).add( this.face.group );

		this.pos = this.group.position;
		this.vel = new THREE.Vector3();
		this.spin = new THREE.Vector3();
		this.tilt = new THREE.Quaternion();
		this.yaw = 0;
		this.speed = 0;
		this.time = Math.random() * 100;
		this.state = kind === 'cyclist' ? 'ride' : 'walk';
		this.stateTime = 0;
		this.cool = 0;
		this.react = null;
		this.groundOffset = 0;
		this.mood = Math.random() < 0.5 ? 0.12 : 0;
		this.chatty = Math.random() < 0.35;
		this.personality = Math.random();
		this.walkSpeed = kind === 'cyclist' ? 3.8 + Math.random() * 2.2 : 1.1 + Math.random() * 0.5;
		this.inset = kind === 'cyclist' ? 4.25 : 1.4 + Math.random() * 2.2;
		this.dir = Math.random() < 0.5 ? 1 : - 1;
		this.expr = {};
		this.weights = { ...NONE };
		this.detail = true;
		this.animAcc = 0;

		if ( kind === 'cyclist' ) {

			this.bike = new Bike( people.bikeParts, people.bikeMaterials, Math.floor( Math.random() * BIKE_COLORS.length ) );

		}

	}

	setDetail( on ) {

		if ( on === this.detail ) return;
		this.detail = on;
		this.face.detail = on;
		this.face.jaw.visible = on;

	}

}

// ---------------------------------------------------------------------------

export class People {

	constructor( scene, world, sound, options = {} ) {

		this.scene = scene;
		this.world = world;
		this.sound = sound;
		this.walkers = options.walkers ?? 30;
		this.cyclists = options.cyclists ?? 8;
		this.list = [];
		this.puffs = [];
		this.puffTimer = 0;
		this.rings = new Map();
		this.frame = 0;
		this.voiceTimer = 0;

	}

	async load() {

		const [ soldier, kit, parts ] = await Promise.all( [ loadSoldier(), new FaceKit().load(), bikeGeometry() ] );
		this.soldier = soldier;
		this.kit = kit;
		this.bodyMaterial = new THREE.MeshStandardMaterial( { vertexColors: true, roughness: 0.78, side: THREE.DoubleSide } );
		this.bikeParts = parts;
		this.bikeMaterials = {
			frame: BIKE_COLORS.map( ( c ) => new THREE.MeshStandardMaterial( { color: c, roughness: 0.4, metalness: 0.3 } ) ),
			dark: new THREE.MeshStandardMaterial( { color: 0x1a1a1a, roughness: 0.7 } ),
			metal: new THREE.MeshStandardMaterial( { color: 0xaaaaaa, roughness: 0.35, metalness: 0.9 } ),
			green: new THREE.MeshStandardMaterial( { color: 0x2fb24c, roughness: 0.5 } )
		};

		// 발밑 그림자 (모두 한 번에 그린다)
		const total = this.walkers + this.cyclists;
		this.shadows = new THREE.InstancedMesh(
			new THREE.PlaneGeometry( 1, 1 ).rotateX( - Math.PI / 2 ),
			new THREE.MeshBasicMaterial( { map: blobShadowTexture(), transparent: true, depthWrite: false, toneMapped: false } ),
			total
		);
		this.shadows.renderOrder = 1;
		this.shadows.frustumCulled = false;
		this.scene.add( this.shadows );
		for ( let i = 0; i < total; i ++ ) {

			const p = new Person( this, i < this.walkers ? 'walker' : 'cyclist', i );
			this.scene.add( p.group );
			if ( p.bike ) this.scene.add( p.bike.group );
			this.list.push( p );

		}

		return this;

	}

	// ---- 길

	ring( bi, bj, inset ) {

		const key = `${ bi },${ bj },${ inset.toFixed( 2 ) }`;
		let r = this.rings.get( key );

		if ( ! r ) {

			const w = this.world, half = w.street / 2;
			r = new Ring( bi * w.periodX + half + inset, bj * w.periodZ + half + inset, ( bi + 1 ) * w.periodX - half - inset, ( bj + 1 ) * w.periodZ - half - inset );
			this.rings.set( key, r );

		}

		return r;

	}

	blockOf( x, z ) {

		return [ Math.floor( x / this.world.periodX ), Math.floor( z / this.world.periodZ ) ];

	}

	place( p, center, spread = 1, avoid = null ) {

		const [ cbi, cbj ] = this.blockOf( center.x, center.z );

		for ( let tries = 0; tries < 20; tries ++ ) {

			p.bi = cbi + Math.round( ( Math.random() * 2 - 1 ) * spread );
			p.bj = cbj + Math.round( ( Math.random() * 2 - 1 ) * spread );
			p.path = this.ring( p.bi, p.bj, p.inset );
			p.s = Math.random() * p.path.L;
			p.path.at( p.s, _p, _t );
			if ( ! avoid || _p.distanceTo( avoid ) > 60 ) break;

		}

		p.pos.set( _p.x, this.world.curb, _p.z );
		p.yaw = Math.atan2( _t.x * p.dir, _t.z * p.dir );
		p.state = p.kind === 'cyclist' ? 'ride' : 'walk';
		p.stateTime = 0;
		p.tilt.identity();
		p.vel.set( 0, 0, 0 );
		p.react = null;
		p.speed = p.walkSpeed;

		if ( p.bike ) {

			p.bike.flying = false;
			p.bike.group.quaternion.identity();

		}

	}

	spawnAll( center ) {

		for ( const p of this.list ) this.place( p, center, 1 );

	}

	// 초기화: 냄새를 걷고 모두 처음처럼 인도로
	reset( center ) {

		this.puffs = [];

		for ( const p of this.list ) {

			p.angry = 0;
			p.cool = 0;
			p.groundOffset = 0;
			p.weights = { ...NONE };
			if ( p.bike ) p.bike.group.position.copy( p.pos );
			this.place( p, center, 1 );

		}

	}

	// ---- 방구 냄새

	smellAt( pos, me, fart ) {

		let s = 0;

		for ( const puff of this.puffs ) {

			const d = pos.distanceTo( puff.pos );
			if ( d < puff.r ) s = Math.max( s, ( 1 - d / puff.r ) * ( 1 - puff.age / puff.life ) );

		}

		if ( fart.active ) {

			const d = pos.distanceTo( me.jetOrigin );
			const reach = fart.physics.reach;
			if ( d < reach ) s = Math.max( s, 1 - d / reach );

		}

		return s;

	}

	// ---- 충격파 / 차에 치임

	shock( center, force, radius ) {

		// 이륙선(내 몸이 뜨는 세기) 아래에서는 사람은 날아가지 않고 놀라기만 한다
		const canLaunch = force >= LIFTOFF_FORCE;

		for ( const p of this.list ) {

			if ( p.state === 'fly' ) continue;
			const rel = p.pos.clone().sub( center );
			const d = rel.length();
			if ( d > radius ) continue;
			const strength = force * ( 1 - d / radius );
			if ( canLaunch && strength > 70 ) this.launch( p, rel.setY( 0 ).normalize(), strength );
			else this.startReact( p, 'scared', 1 );

		}

	}

	hit( pos, velocity, radius = 2.2 ) {

		const speed = Math.hypot( velocity.x, velocity.z );
		if ( speed < 3 ) return;

		for ( const p of this.list ) {

			if ( p.state === 'fly' ) continue;
			if ( Math.abs( p.pos.x - pos.x ) > radius || Math.abs( p.pos.z - pos.z ) > radius || Math.abs( p.pos.y - pos.y ) > 2 ) continue;
			if ( Math.hypot( p.pos.x - pos.x, p.pos.z - pos.z ) > radius ) continue;
			const dir = new THREE.Vector3( velocity.x, 0, velocity.z ).normalize();
			dir.addScaledVector( new THREE.Vector3( p.pos.x - pos.x, 0, p.pos.z - pos.z ).normalize(), 0.5 ).normalize();
			this.launch( p, dir, speed * 18 );

		}

	}

	launch( p, direction, strength ) {

		p.state = 'fly';
		p.stateTime = 0;
		p.vel.copy( direction ).multiplyScalar( 3 + strength / 40 );
		p.vel.y = 3 + strength / 60 + Math.random() * 2;
		p.spin.set( ( Math.random() - 0.5 ) * 8, ( Math.random() - 0.5 ) * 6, ( Math.random() - 0.5 ) * 8 );
		p.pos.y += 0.2;
		this.say( p, 'scream' );

		if ( p.bike && ! p.bike.flying ) {

			p.bike.flying = true;
			p.bike.vel.copy( p.vel ).multiplyScalar( 0.8 );
			p.bike.spin.set( ( Math.random() - 0.5 ) * 9, ( Math.random() - 0.5 ) * 9, ( Math.random() - 0.5 ) * 9 );

		}

	}

	startReact( p, type, strength ) {

		if ( p.state === 'fly' || p.state === 'down' || p.state === 'getup' ) return;
		if ( p.react && p.react.type === type && p.state === 'react' ) return;
		p.react = { type, strength, away: Math.random() < 0.5 ? 1 : - 1 };
		p.state = 'react';
		p.stateTime = 0;
		p.reactTime = type === 'lookup' ? 3 : 1.6 + Math.random() * 1.4;

		// 말풍선 없이 목소리만
		if ( Math.random() < 0.7 ) this.say( p, type );
		if ( p.bike && this.listener && this.listener.distanceTo( p.pos ) < 25 ) this.sound.bell( this.listener.distanceTo( p.pos ) );

	}

	// 한꺼번에 너무 많은 목소리가 겹치지 않도록
	say( p, type ) {

		if ( ! this.listener ) return;
		const d = this.listener.distanceTo( p.pos );
		if ( d > 60 || this.voiceTimer > 0.6 ) return;
		this.voiceTimer += 0.2;
		const female = p.sex === 'female';
		if ( type === 'scream' ) this.sound.scream( d, female );
		else this.sound.voice( type, d, female, p.personality );

	}

	// ------------------------------------------------------------------

	update( dt, me, fart, camera ) {

		this.listener = camera.position;
		this.voiceTimer = Math.max( 0, this.voiceTimer - dt );
		this.frame ++;

		// 방구가 지나간 자리에 냄새 구름을 남긴다
		this.puffTimer -= dt;

		if ( fart.active && this.puffTimer < 0 ) {

			this.puffTimer = 0.2;
			this.puffs.push( { pos: me.jetOrigin.clone(), r: fart.physics.reach * 0.75, age: 0, life: 4 + fart.physics.force / 200, force: fart.physics.force } );

		}

		for ( const puff of this.puffs ) {

			puff.age += dt;
			puff.r += dt * 0.6;

		}

		this.puffs = this.puffs.filter( ( p ) => p.age < p.life );
		if ( this.puffs.length > 60 ) this.puffs.splice( 0, this.puffs.length - 60 );

		const mePos = me.position;
		const flying = me.state === 'air';
		const force = fart.active ? fart.physics.force : ( this.puffs.length ? this.puffs[ this.puffs.length - 1 ].force : 0 );

		for ( let i = 0; i < this.list.length; i ++ ) {

			const p = this.list[ i ];

			// 멀리 있는 사람은 자세를 3 프레임에 한 번만 계산한다
			const far = p.pos.distanceTo( camera.position );
			p.animAcc += dt;
			const animate = far < 260 && ( far < 60 || ( this.frame + i ) % 3 === 0 );
			this.updatePerson( p, dt, me, mePos, fart, force, flying, animate );

			p.setDetail( far < 45 );
			p.group.visible = far < 260;
			if ( p.bike ) p.bike.group.visible = p.group.visible;

			// 멀어지면 내 근처 다른 블록으로 옮긴다
			if ( p.pos.distanceTo( mePos ) > 230 && p.state !== 'fly' ) this.place( p, mePos, 1, camera.position );

			// 그림자
			const ground = this.world.heightAt( p.pos.x, p.pos.z );
			const h = Math.max( 0, p.pos.y - ground );
			_m.compose( _p.set( p.pos.x, ground + 0.02, p.pos.z ), _q.identity(), _s.setScalar( ( p.bike ? 1.4 : 0.9 ) / ( 1 + h * 0.2 ) * ( p.state === 'down' ? 1.7 : 1 ) ) );
			this.shadows.setMatrixAt( i, _m );

		}

		this.shadows.instanceMatrix.needsUpdate = true;

	}

	updatePerson( p, dt, me, mePos, fart, force, flying, animate ) {

		p.time += dt;
		p.stateTime += dt;
		p.cool -= dt;
		const dx = mePos.x - p.pos.x, dz = mePos.z - p.pos.z;
		const dist = Math.hypot( dx, dz );
		const toMe = Math.atan2( dx, dz );
		const smell = p.state === 'fly' ? 0 : this.smellAt( p.pos, me, fart );
		let move = 0;

		// 방구 바람: 원뿔 안에 있으면 날아간다 (이륙선보다 센 방구일 때만)
		if ( fart.active && p.state !== 'fly' && fart.physics.force >= LIFTOFF_FORCE ) {

			const rel = p.pos.clone().sub( me.jetOrigin );
			const d = rel.length();
			const reach = fart.physics.reach;

			if ( d < reach ) {

				const inCone = rel.dot( me.jetDirection ) / Math.max( d, 0.01 ) > 0.55;
				const strength = fart.physics.force * ( 1 - d / reach ) * ( inCone ? 1 : 0.35 );

				if ( strength > 130 ) {

					const push = rel.setY( 0 ).normalize();
					if ( inCone ) push.lerp( new THREE.Vector3( me.jetDirection.x, 0, me.jetDirection.z ).normalize(), 0.6 ).normalize();
					this.launch( p, push, strength );

				}

			}

		}

		const riding = p.kind === 'cyclist';

		switch ( p.state ) {

			case 'walk':
			case 'ride':
			case 'flee': {

				const fleeing = p.state === 'flee';
				const target = fleeing ? ( riding ? p.walkSpeed * 1.6 : 4.6 + p.personality ) : p.walkSpeed;
				p.speed += ( target - p.speed ) * Math.min( 1, dt * 3 );
				move = this.follow( p, dt );

				if ( fleeing && p.stateTime > 3.5 + p.personality * 2 && smell < 0.05 ) {

					p.state = riding ? 'ride' : 'walk';
					p.stateTime = 0;
					p.angry = 0;

				}

				if ( ! fleeing && p.cool < 0 ) {

					if ( smell > 0.02 ) {

						const type = force > 450 ? 'scared' : p.personality < 0.35 ? 'laugh' : p.personality < 0.8 ? 'disgust' : 'scared';
						this.startReact( p, type, smell );
						p.cool = 4 + Math.random() * 3;

					} else if ( flying && dist < 60 && Math.random() < dt * 0.8 ) {

						this.startReact( p, 'lookup', 1 );
						p.cool = 6;

					} else if ( ! riding && Math.random() < dt * 0.025 ) {

						p.state = 'idle';
						p.stateTime = 0;
						p.idleTime = 2 + Math.random() * 5;
						p.idleKind = Math.random() < 0.5 ? 'phone' : 'look';

					}

				}

				break;

			}

			case 'idle':
				p.speed *= Math.max( 0, 1 - dt * 6 );
				if ( p.stateTime > p.idleTime ) {

					p.state = 'walk';
					p.stateTime = 0;

				}

				if ( smell > 0.02 && p.cool < 0 ) {

					this.startReact( p, p.personality < 0.35 ? 'laugh' : 'disgust', smell );
					p.cool = 4;

				}

				break;

			case 'react': {

				p.speed *= Math.max( 0, 1 - dt * ( riding ? 1.5 : 6 ) );
				if ( riding ) move = this.follow( p, dt );

				// 나를 본다 (역겨우면 고개를 돌린다)
				if ( ! riding ) p.yaw += angleTo( toMe - p.yaw ) * Math.min( 1, dt * 4 );

				if ( p.stateTime > p.reactTime ) {

					const t = p.react.type;
					const flee = ( t === 'disgust' && p.personality > 0.55 ) || t === 'scared' || ( smell > 0.3 && t !== 'laugh' );

					if ( flee ) {

						// 나에게서 멀어지는 방향으로 길을 따라 뛴다
						p.path.at( p.s, _p, _t );
						p.dir = ( _t.x * dx + _t.z * dz ) > 0 ? - 1 : 1;
						p.state = 'flee';

					} else {

						p.state = riding ? 'ride' : 'walk';

					}

					p.stateTime = 0;

				}

				break;

			}

			case 'fly': {

				p.vel.y -= 9.81 * dt;
				p.vel.multiplyScalar( Math.max( 0, 1 - dt * 0.05 ) );
				p.pos.addScaledVector( p.vel, dt );
				_q.setFromEuler( _e.set( p.spin.x * dt, p.spin.y * dt, p.spin.z * dt ) );
				p.tilt.premultiply( _q );

				const top = this.world.heightAt( p.pos.x, p.pos.z );
				if ( top > p.pos.y + 1 && top > 2 ) {

					// 건물 벽에 부딪혀 튕긴다
					p.pos.x -= p.vel.x * dt * 2;
					p.pos.z -= p.vel.z * dt * 2;
					p.vel.x *= - 0.3;
					p.vel.z *= - 0.3;

				}

				const floor = this.world.heightAt( p.pos.x, p.pos.z );

				if ( p.pos.y <= floor && p.vel.y < 0 ) {

					p.pos.y = floor;
					const impact = - p.vel.y;
					this.sound.thud( Math.min( 1, impact / 14 ), this.listener.distanceTo( p.pos ) );
					p.state = 'down';
					p.stateTime = 0;
					p.vel.set( 0, 0, 0 );
					p.tilt.identity();
					p.roof = floor > 1;

				}

				break;

			}

			case 'down':
				if ( p.stateTime > 2.4 ) {

					p.state = 'getup';
					p.stateTime = 0;

				}

				break;

			case 'getup':
				if ( p.stateTime > 1.0 ) {

					if ( p.roof ) {

						// 옥상에 떨어진 사람은 조용히 다른 데서 다시 나타난다
						this.place( p, mePos, 1, mePos );
						break;

					}

					p.angry = 4;
					this.say( p, 'angry' );
					p.state = 'return';
					p.stateTime = 0;

					// 가장 가까운 블록 인도로 돌아간다
					const [ bi, bj ] = this.blockOf( p.pos.x, p.pos.z );
					p.bi = bi;
					p.bj = bj;
					p.path = this.ring( bi, bj, p.inset );
					p.s = p.path.project( p.pos.x, p.pos.z );

				}

				break;

			case 'return': {

				p.path.at( p.s, _p, _t );
				const tx = _p.x - p.pos.x, tz = _p.z - p.pos.z;
				const d = Math.hypot( tx, tz );
				p.speed = Math.min( 1.6, d * 2 );
				p.yaw += angleTo( Math.atan2( tx, tz ) - p.yaw ) * Math.min( 1, dt * 5 );
				if ( d > 0.05 ) {

					p.pos.x += tx / d * p.speed * dt;
					p.pos.z += tz / d * p.speed * dt;

				}

				p.pos.y = this.world.heightAt( p.pos.x, p.pos.z );

				if ( d < 0.3 || p.stateTime > 12 ) {

					if ( p.bike ) {

						p.bike.flying = false;
						p.bike.group.quaternion.identity();

					}

					p.state = riding ? 'ride' : 'walk';
					p.stateTime = 0;
					p.pos.y = this.world.curb;

				}

				break;

			}

		}

		if ( p.angry > 0 ) p.angry -= dt;

		if ( p.bike ) p.bike.roll( move );

		if ( animate ) {

			this.pose( p, p.animAcc, toMe );
			p.animAcc = 0;

		}

		if ( p.bike ) this.updateBike( p, dt );

	}

	// 길 따라 걷기 (모퉁이에서는 부드럽게 돈다)
	follow( p, dt ) {

		const step = p.speed * dt;
		p.s += p.dir * step;
		p.path.at( p.s, _p, _t );
		p.path.at( p.s + p.dir * 1.2, _p2, _t2 );
		const lead = _p2.clone().sub( p.pos ).setY( 0 );
		p.pos.x = _p.x;
		p.pos.z = _p.z;
		p.pos.y = this.world.curb;
		if ( lead.lengthSq() > 1e-4 ) p.yaw += angleTo( Math.atan2( lead.x, lead.z ) - p.yaw ) * Math.min( 1, dt * 6 );
		return step;

	}

	updateBike( p, dt ) {

		const b = p.bike;

		if ( b.flying ) {

			b.vel.y -= 9.81 * dt;
			b.group.position.addScaledVector( b.vel, dt );
			_q.setFromEuler( _e.set( b.spin.x * dt, b.spin.y * dt, b.spin.z * dt ) );
			b.group.quaternion.premultiply( _q );
			const floor = this.world.heightAt( b.group.position.x, b.group.position.z );

			if ( b.group.position.y < floor ) {

				// 옆으로 쓰러진 채 멈춘다
				b.group.position.y = floor;
				b.vel.set( 0, 0, 0 );
				b.spin.set( 0, 0, 0 );
				const yaw = new THREE.Euler().setFromQuaternion( b.group.quaternion, 'YXZ' ).y;
				b.group.quaternion.setFromEuler( _e.set( 0, yaw, Math.PI / 2 - 0.15, 'YXZ' ) );

			}

			return;

		}

		if ( p.state === 'ride' || p.state === 'flee' || p.state === 'react' ) {

			b.group.position.copy( p.pos );
			// 놀라면 핸들이 흔들린다
			const wobble = p.state === 'react' ? Math.sin( p.time * 11 ) * 0.12 : 0;
			b.group.rotation.set( 0, p.yaw, wobble );

		} else if ( p.state === 'return' ) {

			// 사람이 자전거로 돌아간다: 일어나면 바로 세운다
			b.group.position.copy( p.pos );
			b.group.rotation.set( 0, p.yaw, 0 );

		}

	}

	// ------------------------------------------------------------------
	// 포즈와 표정: 걷기는 Soldier 애니메이션, 반응은 팔·고개만 그 위에 덮는다

	pose( p, dt, toMe ) {

		const t = p.time;
		const solver = this.soldier.solver;
		const body = p.body;
		const P = walkPose( t, 0, 0 );
		const expr = p.expr;
		for ( const k in expr ) expr[ k ] = 0;
		expr.smile = p.mood;

		// 수다
		if ( p.chatty && Math.sin( t * 0.4 + p.personality * 10 ) > 0.3 ) expr.talk = 0.7;

		const riding = p.bike && ! p.bike.flying && ( p.state === 'ride' || p.state === 'flee' || p.state === 'react' );
		const full = riding || p.state === 'fly' || p.state === 'down' || p.state === 'getup';
		const target = { ...NONE };
		const rel = THREE.MathUtils.clamp( angleTo( toMe - p.yaw ), - 1.2, 1.2 );

		if ( p.state === 'idle' ) {

			if ( p.idleKind === 'phone' ) {

				P.R_upperArm = limb( 0.3, 0.12, - 1 );
				P.R_forearm = limb( 1.95, - 0.55, - 1 );
				P.R_hand.set( 0.3, 0, 0.4 );
				P.neck.x = 0.25;
				P.head.x = 0.35;
				expr.smile = 0.2;
				target.armR = 1;
				target.head = 1;

			} else {

				P.head.y = Math.sin( t * 0.7 ) * 0.7;
				target.head = 1;

			}

		}

		if ( p.state === 'flee' ) {

			const scaredFace = p.react && p.react.type === 'scared';
			expr.browUp = scaredFace ? 0.8 : 0.1;
			expr.frown = scaredFace ? 0 : 0.6;
			expr.sneer = scaredFace ? 0 : 0.6;
			expr.jawOpen = scaredFace ? 0.45 : 0.05;
			expr.squint = scaredFace ? 0 : 0.5;
			expr.wide = scaredFace ? 0.8 : 0;
			expr.smile = 0;

			if ( ! scaredFace && ! riding ) {

				// 코를 막고 도망
				P.R_upperArm = limb( 0.8, - 0.3, - 1 );
				P.R_forearm = limb( 2.75, - 0.95, - 1 );
				target.armR = 1;

			}

		}

		if ( p.state === 'react' && p.react ) {

			const k = Math.min( 1, p.stateTime * 5 );
			const type = p.react.type;

			if ( ! riding ) {

				P.head.y = rel * 0.5;
				P.neck.y = rel * 0.3;
				target.head = 1;
				target.armL = target.armR = 1;
				target.spine = 0.7;

			}

			if ( type === 'disgust' ) {

				if ( ! riding ) {

					P.R_upperArm = lerpV( P.R_upperArm, limb( 0.8, - 0.3, - 1 ), k );
					P.R_forearm = lerpV( P.R_forearm, limb( 2.75, - 0.95, - 1 ), k );
					P.L_upperArm = lerpV( P.L_upperArm, limb( 1.2, 0.45, 1 ), k );
					P.L_forearm = lerpV( P.L_forearm, limb( 2.2 + Math.sin( t * 15 ) * 0.4, 0.15, 1 ), k );
					P.spine.x -= 0.12 * k;
					P.head.y += p.react.away * 0.45 * k;

				}

				expr.frown = 0.6;
				expr.sneer = 0.75;
				expr.squint = 0.55;
				expr.jawOpen = 0.08;
				expr.smile = 0;

			} else if ( type === 'laugh' ) {

				if ( ! riding ) {

					P.L_upperArm = lerpV( P.L_upperArm, limb( 1.45, 0.12, 1 ), k );
					P.L_forearm = lerpV( P.L_forearm, limb( 1.5, 0.05, 1 ), k );
					P.R_upperArm = lerpV( P.R_upperArm, limb( 0.35, 0.22, - 1 ), k );
					P.R_forearm = lerpV( P.R_forearm, limb( 1.7, - 0.95, - 1 ), k );
					P.spine.x += ( 0.12 + Math.sin( t * 13 ) * 0.06 ) * k;

				}

				expr.smile = 0.85;
				expr.jawOpen = 0.2 + Math.abs( Math.sin( t * 12 ) ) * 0.28;
				expr.squint = 0.6;

			} else if ( type === 'scared' ) {

				if ( ! riding ) {

					for ( const [ s, side ] of [ [ 'L', 1 ], [ 'R', - 1 ] ] ) {

						P[ s + '_upperArm' ] = lerpV( P[ s + '_upperArm' ], limb( 0.6, 0.3, side ), k );
						P[ s + '_forearm' ] = lerpV( P[ s + '_forearm' ], limb( 2.75, - 0.6, side ), k );

					}

					P.spine.x -= 0.14 * k;

				}

				expr.browUp = 0.85;
				expr.jawOpen = 0.55;
				expr.wide = 0.8;
				expr.sad = 0.2;
				expr.smile = 0;

			} else if ( type === 'lookup' ) {

				if ( ! riding ) {

					P.L_upperArm = lerpV( P.L_upperArm, limb( 2.55, 0.3, 1 ), k );
					P.L_forearm = lerpV( P.L_forearm, limb( 2.85, 0.2, 1 ), k );
					P.neck.x = - 0.35 * k;
					P.head.x = - 0.45 * k;
					target.armR = 0;

				}

				expr.browUp = 0.7;
				expr.jawOpen = 0.35;
				expr.wide = 0.5;
				expr.smile = 0;

			}

		}

		if ( p.angry > 0 && p.state !== 'react' ) {

			expr.frown = 0.8;
			expr.sneer = 0.25;
			expr.talk = 1;
			expr.smile = 0;

		}

		// ---- 날아감: 허우적
		if ( p.state === 'fly' ) {

			const flail = Math.sin( t * 19 ), flail2 = Math.sin( t * 16 + 1 );
			for ( const [ s, side ] of [ [ 'L', 1 ], [ 'R', - 1 ] ] ) {

				const f = side > 0 ? flail : flail2;
				P[ s + '_upperArm' ] = limb( 1.3 + f * 0.9, 1.6, side );
				P[ s + '_forearm' ] = limb( 1.9 - f, 1.9, side );
				P[ s + '_thigh' ] = limb( 0.3 + f * 0.5, 0.25, side );
				P[ s + '_shin' ] = limb( - 0.2 - f * 0.6, 0.2, side );

			}

			expr.browUp = 1;
			expr.jawOpen = 0.9;
			expr.wide = 1;
			expr.smile = 0;

		}

		// ---- 쓰러짐 / 일어남
		const downT = p.state === 'down' ? Math.min( 1, p.stateTime * 6 ) : p.state === 'getup' ? 1 - Math.min( 1, p.stateTime / 0.9 ) : 0;

		if ( downT > 0 ) {

			P.hipsOffset.y = THREE.MathUtils.lerp( P.hipsOffset.y, 0.14 - solver.hipsRest.y, downT );
			P.hips.x = THREE.MathUtils.lerp( P.hips.x, - Math.PI / 2 + 0.05, downT );
			P.neck.x = THREE.MathUtils.lerp( P.neck.x, 0.25, downT );
			_q.setFromEuler( _e.set( P.hips.x, 0, 0 ) );
			P.legFrame.slerp( _q, downT );

			for ( const [ s, side ] of [ [ 'L', 1 ], [ 'R', - 1 ] ] ) {

				P[ s + '_thigh' ] = lerpV( P[ s + '_thigh' ], limb( 0.05, 0.4, side ), downT );
				P[ s + '_shin' ] = lerpV( P[ s + '_shin' ], limb( 0, 0.45, side ), downT );
				P[ s + '_upperArm' ] = lerpV( P[ s + '_upperArm' ], limb( 0, 1.5, side ), downT );
				P[ s + '_forearm' ] = lerpV( P[ s + '_forearm' ], limb( 0, 1.7, side ), downT );

			}

			expr.closed = p.state === 'down' && p.stateTime > 0.4 ? 1 : 0;
			expr.sad = 0.6;
			expr.frown = 0.3;
			expr.smile = 0;

		}

		// ---- 자전거 타기: 엉덩이는 안장, 발은 페달, 손은 핸들 (IK)
		if ( riding ) {

			const s = 1 / p.scale;
			P.hipsOffset.copy( BIKE.seat ).multiplyScalar( s ).add( _v.set( 0, 0.07 * s, - 0.03 * s ) ).sub( solver.hipsRest );
			P.hips.set( 0.38, 0, 0 );
			P.spine.set( 0.22, 0, 0 );
			P.chest.set( 0.12, 0, 0 );
			P.neck.x = - 0.42;
			P.head.x = - 0.25 + ( P.head.x || 0 );
			P.legFrame.identity();
			const r1 = solver.solve( P );

			const b = p.bike;
			for ( const [ side, sgn, off ] of [ [ 'L', 1, 0 ], [ 'R', - 1, Math.PI ] ] ) {

				const a = b.angle + off;
				const pedal = _v.set( sgn * 0.13, BIKE.bb.y - Math.cos( a ) * BIKE.crank + 0.07, BIKE.bb.z - Math.sin( a ) * BIKE.crank - 0.03 ).multiplyScalar( s );
				const leg = solver.legIK( r1.pos[ side + '_thigh' ], pedal, _v2.set( sgn * 0.15, 0.3, 1 ).normalize() );
				P[ side + '_thigh' ] = leg.thigh;
				P[ side + '_shin' ] = leg.shin;
				P[ side + '_foot' ] = new THREE.Vector3( sgn * 0.1, - 0.25, 1 ).normalize();

				if ( p.state === 'react' && p.react.type === 'disgust' && side === 'R' ) {

					// 한 손으로 코 막고 운전
					P.R_upperArm = limb( 0.8, - 0.3, - 1 ).applyQuaternion( r1.world.chest );
					P.R_forearm = limb( 2.75, - 0.95, - 1 ).applyQuaternion( r1.world.chest );
					continue;

				}

				const grip = _v3.set( sgn * 0.25, BIKE.bar.y, BIKE.bar.z - 0.07 ).multiplyScalar( s );
				const arm = solver.armIK( r1.pos[ side + '_upperArm' ], grip, _v2.set( sgn * 0.7, - 0.6, - 0.3 ).normalize() );
				P[ side + '_upperArm' ] = arm.upper;
				P[ side + '_forearm' ] = arm.fore;

			}

			P.armWorld = true;

		}

		// 애니메이션 (자전거·날기·쓰러짐 중에는 서 있는 손가락만 쓴다)
		body.locomote( dt, full ? 0 : p.speed );

		// 부위별 섞는 비율을 부드럽게 바꾼다
		const k = Math.min( 1, dt * 7 );
		let any = 0;

		for ( const g in p.weights ) {

			const goal = full ? 1 : target[ g ];
			p.weights[ g ] += ( goal - p.weights[ g ] ) * ( full ? 1 : k );
			any = Math.max( any, p.weights[ g ] );

		}

		if ( any > 0.01 ) {

			const r = solver.solve( P );

			// 쓰러졌다 일어날 때만 발을 땅에 맞춘다
			if ( downT > 0 ) {

				const lowest = Math.min( r.footL, r.footR );
				p.groundOffset = THREE.MathUtils.lerp( p.groundOffset, - lowest * ( 1 - downT ), Math.min( 1, dt * 18 ) );

			} else p.groundOffset = 0;

			body.apply( r, full ? ALL : p.weights, p.groundOffset );

		}

		// 몸 방향
		_q.setFromAxisAngle( _up, p.yaw );
		p.group.quaternion.copy( p.tilt ).multiply( _q );

		p.face.update( dt, expr );

	}

	// 카메라 연출용: 가장 재미있는 사람
	interesting( center ) {

		let best = null, score = - Infinity;

		for ( const p of this.list ) {

			const d = p.pos.distanceTo( center );
			if ( d > 70 ) continue;
			const s = ( p.state === 'fly' ? 50 : p.state === 'react' ? 30 : p.state === 'flee' ? 18 : p.state === 'down' ? 12 : 0 ) - d * 0.4 + ( p.bike ? 3 : 0 );
			if ( s > score ) {

				score = s;
				best = p;

			}

		}

		return best;

	}

}

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _p2 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const _up = new THREE.Vector3( 0, 1, 0 );
