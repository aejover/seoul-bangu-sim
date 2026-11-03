import * as THREE from 'three/webgpu';

// 카메라 시점: 1인칭, 3인칭(OrbitControls 는 main 에서), 사람들, 도시 전체, 자동 연출

export const CAMERA_MODES = [
	{ id: 'first', label: '1인칭' },
	{ id: 'third', label: '3인칭' },
	{ id: 'people', label: '사람들' },
	{ id: 'city', label: '도시 전체' },
	{ id: 'auto', label: '자동 연출' }
];

const SHOT_NAMES = {
	chase: '추격 캠', low: '로우 앵글', orbit: '빙글빙글', reaction: '리액션 캠', aerial: '항공 촬영', tripod: '고정 카메라', face: '내 얼굴', wide: '현장 전체'
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class Director {

	constructor( camera, world, dom ) {

		this.camera = camera;
		this.world = world;
		this.mode = 'third';
		this.pos = new THREE.Vector3();
		this.target = new THREE.Vector3();
		this.fov = 55;
		this.time = 0;
		this.shot = null;
		this.shotTime = 0;
		this.subject = null;
		this.subjectTime = 0;
		this.cut = true;
		this.fpYaw = Math.PI;
		this.fpPitch = 0;
		this.tripod = new THREE.Vector3();
		this.label = '';

		// 1인칭에서는 드래그로 둘러본다
		let drag = null;
		dom.addEventListener( 'pointerdown', ( e ) => {

			if ( this.mode === 'first' ) drag = { x: e.clientX, y: e.clientY };

		} );
		window.addEventListener( 'pointermove', ( e ) => {

			if ( ! drag || this.mode !== 'first' ) return;
			this.fpYaw -= ( e.clientX - drag.x ) * 0.005;
			this.fpPitch = THREE.MathUtils.clamp( this.fpPitch - ( e.clientY - drag.y ) * 0.004, - 1.2, 1.2 );
			drag = { x: e.clientX, y: e.clientY };

		} );
		window.addEventListener( 'pointerup', () => {

			drag = null;

		} );

	}

	setMode( mode, ctx ) {

		this.mode = mode;
		this.cut = true;
		this.shot = null;
		this.subject = null;
		if ( mode === 'first' && ctx ) this.fpYaw = ctx.me.yaw;

	}

	nextSubject() {

		this.subject = null;
		this.cut = true;

	}

	// 사람이 건물 안에 들어가지 않도록
	outside( p, around ) {

		if ( this.world.heightAt( p.x, p.z ) > p.y - 0.3 ) {

			// 반대편으로 돌려 본다
			_v2.copy( p ).sub( around );
			_v2.x = - _v2.x;
			_v2.z = - _v2.z;
			const q = around.clone().add( _v2 );
			if ( this.world.heightAt( q.x, q.z ) < q.y - 0.3 ) return p.copy( q );
			p.y = Math.max( p.y, this.world.heightAt( p.x, p.z ) + 2 );

		}

		return p;

	}

	// ctx: { dt, me, people, traffic, fart, driving, events }
	update( ctx ) {

		const dt = ctx.dt;
		this.time += dt;
		const me = ctx.me;
		const head = me.position.clone().add( _v.set( 0, me.state === 'down' ? 0.4 : 1.4, 0 ) );
		const forward = ctx.driving ? ctx.traffic.player.heading.clone() : new THREE.Vector3( Math.sin( me.yaw ), 0, Math.cos( me.yaw ) );
		let pos = null, target = null, fov = 55, smooth = 6;
		this.label = '';

		if ( this.mode === 'first' ) {

			if ( ctx.driving ) {

				// 운전석
				const car = ctx.traffic.player;
				const left = new THREE.Vector3( car.heading.z, 0, - car.heading.x );
				pos = car.pos.clone().addScaledVector( car.heading, - 0.25 ).addScaledVector( left, 0.34 ).add( _v.set( 0, 0.55, 0 ) );
				this.fpYaw += THREE.MathUtils.euclideanModulo( Math.atan2( car.heading.x, car.heading.z ) - this.fpYaw + Math.PI, Math.PI * 2 ) - Math.PI;

			} else {

				me.bones.head.getWorldPosition( _v2 );
				pos = _v2.clone().add( _v.set( 0, 0.12, 0 ) ).addScaledVector( forward, 0.16 );
				// 하늘을 날 땐 몸이 보는 쪽으로
				if ( me.state === 'air' ) this.fpYaw += ( THREE.MathUtils.euclideanModulo( me.yaw - this.fpYaw + Math.PI, Math.PI * 2 ) - Math.PI ) * Math.min( 1, dt * 3 );

			}

			const c = Math.cos( this.fpPitch );
			target = pos.clone().add( _v.set( Math.sin( this.fpYaw ) * c, Math.sin( this.fpPitch ), Math.cos( this.fpYaw ) * c ) );
			fov = 72;
			smooth = 0;

		} else if ( this.mode === 'people' ) {

			const r = this.peopleShot( ctx, head );
			pos = r.pos;
			target = r.target;
			fov = r.fov;
			this.label = r.label;

		} else if ( this.mode === 'city' ) {

			const a = this.time * 0.04;
			pos = new THREE.Vector3( me.position.x + Math.sin( a ) * 520, 330, me.position.z + Math.cos( a ) * 520 );
			target = me.position.clone();
			fov = 50;
			smooth = 2;

		} else if ( this.mode === 'auto' ) {

			const r = this.autoShot( ctx, head, forward );
			pos = r.pos;
			target = r.target;
			fov = r.fov;
			smooth = r.smooth ?? 5;
			this.label = '🎬 ' + SHOT_NAMES[ this.shot ];

		}

		if ( ! pos ) return false;

		this.outside( pos, target );

		if ( this.cut || smooth === 0 ) {

			this.pos.copy( pos );
			this.target.copy( target );
			this.fov = fov;
			this.cut = false;

		} else {

			const k = Math.min( 1, dt * smooth );
			this.pos.lerp( pos, k );
			this.target.lerp( target, Math.min( 1, dt * smooth * 1.5 ) );
			this.fov += ( fov - this.fov ) * k;

		}

		this.camera.position.copy( this.pos );
		this.camera.lookAt( this.target );

		if ( Math.abs( this.camera.fov - this.fov ) > 0.01 ) {

			this.camera.fov = this.fov;
			this.camera.updateProjectionMatrix();

		}

		return true;

	}

	// 행인 한 명의 얼굴을 앞에서 찍는다
	faceShot( p, dist = 1.4 ) {

		const head = new THREE.Vector3();
		p.rig.bones.head.getWorldPosition( head );
		head.y += 0.1;
		const f = new THREE.Vector3( Math.sin( p.yaw ), 0, Math.cos( p.yaw ) );

		if ( p.state === 'fly' || p.state === 'down' ) {

			return { pos: p.pos.clone().add( _v.set( 4, 3, 4 ) ), target: p.pos.clone().add( _v.set( 0, 0.5, 0 ) ), fov: 55 };

		}

		const side = new THREE.Vector3( f.z, 0, - f.x ).multiplyScalar( 0.45 );
		return { pos: head.clone().addScaledVector( f, dist ).add( side ).add( _v.set( 0, - 0.05, 0 ) ), target: head.clone().add( _v.set( 0, - 0.08, 0 ) ), fov: 42 };

	}

	peopleShot( ctx, head ) {

		this.subjectTime += ctx.dt;
		const list = ctx.people.list;

		if ( ! this.subject || this.subjectTime > 7 || ! this.subject.group.visible ) {

			// 반응 중인 사람을 먼저, 없으면 가까운 사람 아무나
			const pick = ctx.people.interesting( ctx.me.position );
			const near = list.filter( ( p ) => p.pos.distanceTo( ctx.me.position ) < 60 && p !== this.subject );
			this.subject = ( pick && pick.state !== 'walk' && pick.state !== 'ride' ) ? pick : near[ Math.floor( Math.random() * near.length ) ] || list[ 0 ];
			this.subjectTime = 0;
			this.cut = true;

		}

		const shot = this.faceShot( this.subject );
		const p = this.subject;
		const name = p.kind === 'cyclist' ? '자전거 타는 사람' : p.sex === 'female' ? '지나가던 여자' : '지나가던 남자';
		return { ...shot, label: '사람들 · ' + name };

	}

	pickShot( ctx ) {

		const me = ctx.me;
		const flying = me.state === 'air';
		const strong = ctx.fart.active && ctx.fart.physics.force > 300;
		const reacting = ctx.people.interesting( me.position );
		const options = [];

		if ( flying ) options.push( 'chase', 'chase', 'tripod', 'aerial', 'low' );
		else if ( strong ) options.push( 'low', 'wide', 'face' );
		else if ( reacting && reacting.state !== 'walk' && reacting.state !== 'ride' ) options.push( 'reaction', 'reaction', 'wide' );
		else if ( ctx.driving ) options.push( 'chase', 'tripod', 'low', 'aerial' );
		else options.push( 'chase', 'orbit', 'face', 'aerial', 'reaction', 'tripod', 'low' );

		let shot;
		do shot = options[ Math.floor( Math.random() * options.length ) ];
		while ( shot === this.shot && options.length > 1 && new Set( options ).size > 1 );
		return shot;

	}

	autoShot( ctx, head, forward ) {

		const me = ctx.me;
		this.shotTime += ctx.dt;

		// 사건이 생기면 바로 컷
		const event = ctx.events.find( ( e ) => e === 'liftoff' || e === 'launch' || e === 'destroy' || e === 'shock' );
		const minTime = this.shot ? 1.6 : 0;
		const length = this.shot === 'face' ? 3 : this.shot === 'aerial' ? 5 : 5.5;

		if ( ! this.shot || this.shotTime > length || ( event && this.shotTime > minTime ) ) {

			this.shot = event === 'destroy' || event === 'launch' ? 'wide' : event === 'liftoff' ? 'tripod' : event === 'shock' ? 'low' : this.pickShot( ctx );
			this.shotTime = 0;
			this.cut = true;
			this.subject = null;
			this.orbitStart = Math.random() * Math.PI * 2;

			// 고정 카메라는 내가 갈 방향 앞쪽 땅에 세운다
			const vel = me.velocity.clone().setY( 0 );
			const ahead = vel.lengthSq() > 1 ? vel.normalize() : forward;
			this.tripod.copy( me.position ).addScaledVector( ahead, 14 ).add( _v.set( ahead.z * 6, 1.6, - ahead.x * 6 ) );
			this.tripod.y = this.world.heightAt( this.tripod.x, this.tripod.z ) + 1.6;

		}

		const t = this.shotTime;
		const side = new THREE.Vector3( forward.z, 0, - forward.x );

		switch ( this.shot ) {

			case 'chase': {

				const back = ctx.driving ? 8 : me.state === 'air' ? 9 : 5;
				return { pos: head.clone().addScaledVector( forward, - back ).add( _v.set( 0, ctx.driving ? 2.2 : 1.6, 0 ) ), target: head.clone().addScaledVector( forward, 3 ), fov: 60, smooth: 4 };

			}

			case 'low':
				return { pos: head.clone().addScaledVector( forward, 3.2 ).addScaledVector( side, 1.4 + t * 0.15 ).setY( me.position.y + 0.35 ), target: head.clone().add( _v.set( 0, 0.2, 0 ) ), fov: 46, smooth: 3 };

			case 'orbit': {

				const a = this.orbitStart + t * 0.35;
				return { pos: head.clone().add( _v.set( Math.sin( a ) * 7, 1.8, Math.cos( a ) * 7 ) ), target: head, fov: 50, smooth: 8 };

			}

			case 'face':
				return { pos: head.clone().addScaledVector( forward, 1.7 - t * 0.12 ).add( _v.set( 0, 0.05, 0 ) ), target: head.clone().add( _v.set( 0, 0.05, 0 ) ), fov: 40, smooth: 6 };

			case 'aerial': {

				const a = this.orbitStart + t * 0.12;
				const h = me.state === 'air' ? me.position.y + 50 : 70;
				return { pos: me.position.clone().add( _v.set( Math.sin( a ) * 70, h - me.position.y, Math.cos( a ) * 70 ) ), target: me.position.clone(), fov: 50, smooth: 2 };

			}

			case 'wide':
				return { pos: me.position.clone().addScaledVector( side, 22 ).addScaledVector( forward, 14 ).add( _v.set( 0, 12 + t * 1.5, 0 ) ), target: me.position.clone().add( _v.set( 0, 4, 0 ) ), fov: 58, smooth: 2 };

			case 'tripod':
				return { pos: this.tripod.clone(), target: head, fov: 48, smooth: 0 };

			case 'reaction': {

				if ( ! this.subject ) this.subject = ctx.people.interesting( me.position ) || ctx.people.list[ 0 ];
				const shot = this.faceShot( this.subject, 1.9 );
				return { ...shot, smooth: 5 };

			}

		}

		return { pos: head.clone().add( _v.set( 0, 2, 6 ) ), target: head, fov: 55 };

	}

}
