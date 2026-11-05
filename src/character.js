import * as THREE from 'three/webgpu';
import { walkPose, limb, lerpV, blobShadowTexture } from './rig.js';
import { loadSoldier, SoldierBody, dressedGeometry } from './soldier.js';

export { ASSETS, limb } from './rig.js';

// 얼굴: 첨부한 이미지처럼 주황 바탕에 검은 네모 눈 두 개
export const FACE_ORANGE = '#ff6726';

// ---------------------------------------------------------------------------
// 얼굴 텍스처

function createFace() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = 256;
	const ctx = canvas.getContext( '2d' );
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;

	let last = '';

	// open: 1 = 기본, 0 = 감음 / squint: 힘주기 / red: 얼굴 붉어짐
	function draw( open = 1, squint = 0, red = 0 ) {

		const key = `${ open.toFixed( 2 ) }|${ squint.toFixed( 2 ) }|${ red.toFixed( 2 ) }`;
		if ( key === last ) return;
		last = key;

		const base = new THREE.Color( FACE_ORANGE ).lerp( new THREE.Color( '#e8282a' ), red * 0.7 );
		ctx.fillStyle = '#' + base.getHexString();
		ctx.fillRect( 0, 0, 256, 256 );
		ctx.fillStyle = '#000';

		// 원본 이미지 비율: 눈 가로 0.189~0.392 / 0.603~0.806, 세로 0.289~0.492
		const cy = 0.39 * 256;
		const h = Math.max( 0.012, 0.203 * open * ( 1 - squint * 0.78 ) ) * 256;
		const inner = squint * 0.03 * 256;
		ctx.fillRect( 0.189 * 256 + inner, cy - h / 2, 0.203 * 256, h );
		ctx.fillRect( 0.603 * 256 - inner, cy - h / 2, 0.203 * 256, h );
		texture.needsUpdate = true;

	}

	draw();

	return { texture, draw };

}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();


export class Character {

	constructor() {

		this.group = new THREE.Group();
		this.group.name = 'Me';

		this.position = this.group.position;
		this.velocity = new THREE.Vector3();
		this.yaw = 0;
		this.state = 'ground'; // ground | air | down | getup
		this.stateTime = 0;
		this.speed = 0;
		this.phase = 0;
		this.fartBlend = 0;
		this.flightPitch = 0.35;
		this.flyBlend = 0;
		this.downBlend = 0;
		this.blinkTimer = 2;
		this.time = 0;
		this.relief = 0;
		this.dancing = false;
		this.danceBlend = 0;
		this.danceTime = 0;

		this.nozzle = new THREE.Object3D();
		this.jetDirection = new THREE.Vector3( 0, - 0.8, - 0.6 );
		this.jetOrigin = new THREE.Vector3();

	}

	async load() {

		// 몸은 Soldier, 옷은 검정 가죽 재킷 + 흰 티 + 와이드 흑청 + 흰 운동화
		const kit = await loadSoldier();
		this.kit = kit;
		this.solver = kit.solver;
		const outfit = { open: true, jacket: 0x161616, inner: 0xf2f2ee, pants: 0x2f333b, wide: 0.42, shoes: 0xf2f2ee, belt: 0x111111 };
		const material = new THREE.MeshStandardMaterial( { vertexColors: true, roughness: 0.72, side: THREE.DoubleSide } );
		this.body = new SoldierBody( kit, dressedGeometry( kit, outfit, 'male', 0xe9c3a4 ), material );
		this.mesh = this.body.mesh;
		this.mesh.name = 'MeBody';
		this.group.add( this.body.root );
		const J = kit.joints;
		const headMount = this.body.attach( 'Head', J.head );
		this.headMount = headMount; // 1인칭 카메라 자리
		this.hipsMount = this.body.attach( 'Hips', J.hips );

		// 네모 얼굴 머리
		this.face = createFace();
		// 그늘에서도 이미지 속 주황색이 살도록 살짝 스스로 빛나게
		const orange = new THREE.MeshStandardMaterial( { color: FACE_ORANGE, roughness: 0.65, emissive: FACE_ORANGE, emissiveIntensity: 2.2 } );
		const front = new THREE.MeshStandardMaterial( { map: this.face.texture, roughness: 0.65, emissive: 0xffffff, emissiveMap: this.face.texture, emissiveIntensity: 2.2 } );
		this.headMaterials = [ orange, front ];
		const size = 0.3;
		const head = new THREE.Mesh( new THREE.BoxGeometry( size, size, size ), [ orange, orange, orange, orange, front, orange ] );
		head.position.set( 0, size / 2 - 0.02, 0.0 );
		head.name = 'FaceHead';
		headMount.add( head );
		this.head = head;

		// 엉덩이 분사구
		this.nozzle.position.copy( J.anus ).sub( J.hips );
		this.hipsMount.add( this.nozzle );

		// 발밑 그림자
		this.shadow = new THREE.Mesh(
			new THREE.PlaneGeometry( 1, 1 ).rotateX( - Math.PI / 2 ),
			new THREE.MeshBasicMaterial( { map: blobShadowTexture(), transparent: true, depthWrite: false, toneMapped: false } )
		);
		this.shadow.renderOrder = 1;

		this.groundOffset = 0;

		return this;

	}

	solve( pose ) {

		return this.solver.solve( pose );

	}

	// ------------------------------------------------------------------

	buildPose( dt, f ) {

		const t = this.time;
		// 서 있는 기본 자세 (걷는 동작은 애니메이션이 맡는다)
		const P = walkPose( t, 0, 0 );
		const move = THREE.MathUtils.clamp( this.speed / 1.4, 0, 1 );

		// ---- 춤: 120 BPM, 8박자(4초)마다 동작이 바뀐다 (만세 펌프 → 디스코 손가락 → 무릎 바운스 웨이브)
		const dance = this.danceBlend;

		if ( dance > 0.001 ) {

			const beat = this.danceTime * 2; // 박자 수
			const b = beat * Math.PI; // 한 박자에 반 바퀴
			const bounce = Math.abs( Math.sin( b ) );
			const step = Math.floor( beat / 8 ) % 3;
			const side = Math.sin( b * 0.5 );
			const D = walkPose( t, 0, 0 );

			D.hipsOffset.y = - 0.06 * bounce;
			D.hips.set( 0.04, side * 0.25, side * 0.1 );
			D.spine.set( 0.05 * bounce, - side * 0.15, - side * 0.08 );
			D.head.set( - 0.1 * bounce, side * 0.3, side * 0.15 );

			for ( const [ s, sg ] of [ [ 'L', 1 ], [ 'R', - 1 ] ] ) {

				// 무릎을 박자에 맞춰 굽혔다 편다
				const knee = 0.25 + 0.35 * bounce;
				D[ s + '_thigh' ] = limb( knee * 0.6, 0.12, sg );
				D[ s + '_shin' ] = limb( - knee * 0.5, 0.06, sg );

				if ( step === 0 ) {

					// 양손 번갈아 하늘로 펌프
					const up = Math.max( 0, Math.sin( b + ( sg > 0 ? 0 : Math.PI ) ) );
					D[ s + '_upperArm' ] = limb( 0.3 + up * 2.5, 0.35, sg );
					D[ s + '_forearm' ] = limb( 0.6 + up * 2.4, 0.25, sg );

				} else if ( step === 1 ) {

					// 디스코: 한 손은 위로 비스듬히 찌르고 다른 손은 허리
					const point = ( Math.floor( beat / 2 ) % 2 === 0 ) === ( sg > 0 );
					D[ s + '_upperArm' ] = point ? limb( 2.3, 0.6, sg ) : limb( 0.3, 0.6, sg );
					D[ s + '_forearm' ] = point ? limb( 2.6, 0.5, sg ) : limb( 1.8, - 0.9, sg );

				} else {

					// 웨이브: 양팔을 옆으로 뻗고 물결치듯
					const wave = Math.sin( b + ( sg > 0 ? 0 : 1.2 ) );
					D[ s + '_upperArm' ] = limb( 0.2, 1.45 + wave * 0.35, sg );
					D[ s + '_forearm' ] = limb( 0.2 + wave * 0.6, 1.5 - wave * 0.6, sg );

				}

			}

			for ( const k of Object.keys( D ) ) {

				if ( D[ k ].isVector3 && P[ k ] && P[ k ].isVector3 && k !== 'hipsOffset' ) P[ k ] = lerpV( P[ k ], D[ k ], dance );
				else if ( D[ k ].isEuler ) P[ k ].set( THREE.MathUtils.lerp( P[ k ].x, D[ k ].x, dance ), THREE.MathUtils.lerp( P[ k ].y, D[ k ].y, dance ), THREE.MathUtils.lerp( P[ k ].z, D[ k ].z, dance ) );

			}

			P.hipsOffset.lerp( D.hipsOffset, dance );

		}

		// ---- 방구 자세: 엉덩이 쭉, 한쪽 다리 들기, 팔 벌려 균형
		const fb = this.fartBlend * ( 1 - this.flyBlend );

		if ( fb > 0.001 ) {

			const power = THREE.MathUtils.clamp( f.force / 500, 0.15, 1 );
			const shake = ( Math.random() - 0.5 ) * 0.09 * power;
			const shake2 = ( Math.random() - 0.5 ) * 0.09 * power;

			P.hips.x = THREE.MathUtils.lerp( P.hips.x, 0.32, fb );
			P.hips.z = THREE.MathUtils.lerp( P.hips.z, 0.1, fb );
			P.spine.x = THREE.MathUtils.lerp( P.spine.x, 0.16 + shake, fb );
			P.chest.x = THREE.MathUtils.lerp( P.chest.x, 0.18, fb );
			P.chest.z = THREE.MathUtils.lerp( P.chest.z, - 0.08 + shake2, fb );
			P.neck.x = THREE.MathUtils.lerp( P.neck.x, - 0.35, fb );
			P.head.x = THREE.MathUtils.lerp( P.head.x, - 0.25 + shake, fb );
			P.head.y = THREE.MathUtils.lerp( P.head.y, 0, fb );

			// 오른 다리를 옆으로 들어올림
			P.R_thigh = lerpV( P.R_thigh, limb( 0.2, 0.55, - 1 ), fb );
			P.R_shin = lerpV( P.R_shin, limb( - 0.25, 0.45, - 1 ), fb );
			P.R_foot = lerpV( P.R_foot, new THREE.Vector3( - 0.5, 0.1, 1 ).normalize(), fb );
			P.L_thigh = lerpV( P.L_thigh, limb( 0.12, 0.04, 1 ), fb );
			P.L_shin = lerpV( P.L_shin, limb( - 0.15, 0.03, 1 ), fb );
			P.L_foot = lerpV( P.L_foot, new THREE.Vector3( 0.2, - 0.3, 1 ).normalize(), fb );

			// 팔 벌려 균형 (힘줄수록 부들부들)
			P.L_upperArm = lerpV( P.L_upperArm, limb( 0.3, 1.05 + shake, 1 ), fb );
			P.L_forearm = lerpV( P.L_forearm, limb( 0.6, 1.35, 1 ), fb );
			P.R_upperArm = lerpV( P.R_upperArm, limb( 0.3, 1.1 + shake2, - 1 ), fb );
			P.R_forearm = lerpV( P.R_forearm, limb( 0.6, 1.4, - 1 ), fb );
			P.L_hand.set( 0, 0, - 0.4 * fb );
			P.R_hand.set( 0, 0, 0.4 * fb );

		}

		// ---- 시원한 마무리 (방구 끝난 직후 상쾌한 기지개)
		if ( this.relief > 0 && fb < 0.5 ) {

			const r = Math.sin( Math.min( 1, this.relief ) * Math.PI ) * ( 1 - move );
			P.chest.x -= 0.15 * r;
			P.neck.x -= 0.2 * r;
			P.L_upperArm = lerpV( P.L_upperArm, limb( 0.2, 2.6, 1 ), r * 0.8 );
			P.R_upperArm = lerpV( P.R_upperArm, limb( 0.2, 2.6, - 1 ), r * 0.8 );
			P.L_forearm = lerpV( P.L_forearm, limb( 0.2, 2.9, 1 ), r * 0.8 );
			P.R_forearm = lerpV( P.R_forearm, limb( 0.2, 2.9, - 1 ), r * 0.8 );

		}

		// ---- 공중: 방구 로켓 비행 / 추락 허우적
		const fly = this.flyBlend;

		if ( fly > 0.001 ) {

			const thrusting = f.active;
			const flail = Math.sin( t * 18 );
			const flail2 = Math.sin( t * 15 + 1 );

			P.hips.x = THREE.MathUtils.lerp( P.hips.x, this.flightPitch, fly );
			P.hips.z = THREE.MathUtils.lerp( P.hips.z, 0, fly );
			P.spine.x = THREE.MathUtils.lerp( P.spine.x, 0.05, fly );
			P.chest.x = THREE.MathUtils.lerp( P.chest.x, 0.05, fly );
			P.neck.x = THREE.MathUtils.lerp( P.neck.x, - 0.5 * Math.min( 1, this.flightPitch * 1.4 ), fly );
			P.head.x = THREE.MathUtils.lerp( P.head.x, - 0.2, fly );

			// 다리는 골반을 따라간다
			_q.setFromEuler( _e.set( P.hips.x, P.hips.y, P.hips.z ) );
			P.legFrame.slerp( _q, fly );

			const kick = thrusting ? 0.15 : 0.6;
			P.L_thigh = lerpV( P.L_thigh, limb( 0.15 + flail * kick * 0.6, 0.12, 1 ), fly );
			P.L_shin = lerpV( P.L_shin, limb( - 0.3 + flail * kick, 0.1, 1 ), fly );
			P.R_thigh = lerpV( P.R_thigh, limb( 0.15 - flail * kick * 0.6, 0.12, - 1 ), fly );
			P.R_shin = lerpV( P.R_shin, limb( - 0.3 - flail * kick, 0.1, - 1 ), fly );
			P.L_foot = lerpV( P.L_foot, new THREE.Vector3( 0.2, - 0.8, 0.6 ).normalize(), fly );
			P.R_foot = lerpV( P.R_foot, new THREE.Vector3( - 0.2, - 0.8, 0.6 ).normalize(), fly );

			// 팔: 비행 중엔 슈퍼맨처럼 앞으로, 추락 중엔 허우적
			const supermanL = limb( 2.6, 0.25, 1 ), supermanR = limb( 2.0 + flail * 0.5, 0.9, - 1 );
			const panicL = limb( 1.2 + flail * 0.9, 1.6, 1 ), panicR = limb( 1.2 - flail2 * 0.9, 1.6, - 1 );
			P.L_upperArm = lerpV( P.L_upperArm, thrusting ? supermanL : panicL, fly );
			P.R_upperArm = lerpV( P.R_upperArm, thrusting ? supermanR : panicR, fly );
			P.L_forearm = lerpV( P.L_forearm, thrusting ? limb( 2.8, 0.2, 1 ) : limb( 1.8 + flail2, 1.9, 1 ), fly );
			P.R_forearm = lerpV( P.R_forearm, thrusting ? limb( 2.4, 1.2, - 1 ) : limb( 1.8 - flail, 1.9, - 1 ), fly );

		}

		// ---- 쿵! 엉덩방아 후 대자로 뻗음
		const down = this.downBlend;

		if ( down > 0.001 ) {

			P.hipsOffset.y = THREE.MathUtils.lerp( P.hipsOffset.y, 0.14 - this.solver.hipsRest.y, down );
			P.hipsOffset.z = THREE.MathUtils.lerp( P.hipsOffset.z, 0.0, down );
			P.hips.x = THREE.MathUtils.lerp( P.hips.x, - Math.PI / 2 + 0.05, down );
			P.hips.z = THREE.MathUtils.lerp( P.hips.z, 0, down );
			P.neck.x = THREE.MathUtils.lerp( P.neck.x, 0.25, down );
			P.head.y = THREE.MathUtils.lerp( P.head.y, Math.sin( t * 3 ) * 0.5, down );
			_q.setFromEuler( _e.set( P.hips.x, 0, 0 ) );
			P.legFrame.slerp( _q, down );
			for ( const [ s, side ] of [ [ 'L', 1 ], [ 'R', - 1 ] ] ) {

				P[ s + '_thigh' ] = lerpV( P[ s + '_thigh' ], limb( 0.05, 0.4, side ), down );
				P[ s + '_shin' ] = lerpV( P[ s + '_shin' ], limb( 0, 0.45, side ), down );
				P[ s + '_foot' ] = lerpV( P[ s + '_foot' ], new THREE.Vector3( side * 0.4, - 1, 0.3 ).normalize(), down );
				P[ s + '_upperArm' ] = lerpV( P[ s + '_upperArm' ], limb( 0, 1.5, side ), down );
				P[ s + '_forearm' ] = lerpV( P[ s + '_forearm' ], limb( 0, 1.7, side ), down );

			}

		}

		return P;

	}

	// ------------------------------------------------------------------

	update( dt, input, world, fart ) {

		this.time += dt;
		this.stateTime += dt;

		const g = 9.81;
		const mass = 70;
		const forward = new THREE.Vector3( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		const groundY = world.heightAt( this.position.x, this.position.z, this.position.y );

		const farting = fart.active;
		const F = fart.force;
		const thrust = farting ? this.jetDirection.clone().multiplyScalar( - F ) : new THREE.Vector3();

		if ( this.state === 'ground' ) {

			// 걷기 / 달리기
			const wish = input.move.clone();
			// 달리기는 거의 우사인 볼트
			const target = farting ? 0 : ( input.run ? 8.5 : 2.0 );
			const hv = new THREE.Vector3( this.velocity.x, 0, this.velocity.z );

			if ( wish.lengthSq() > 0.01 ) {

				wish.normalize();
				const want = Math.atan2( wish.x, wish.z );
				let d = want - this.yaw;
				d = Math.atan2( Math.sin( d ), Math.cos( d ) );
				this.yaw += d * Math.min( 1, dt * ( farting ? 2 : 10 ) );
				hv.lerp( wish.multiplyScalar( target ), Math.min( 1, dt * 8 ) );

			} else {

				hv.multiplyScalar( Math.max( 0, 1 - dt * 9 ) );

			}

			// 방구 추력: 세로 성분이 몸무게를 넘으면 이륙, 가로 성분이 마찰을 넘으면 미끄러짐
			if ( farting ) {

				const up = thrust.y;
				const normal = Math.max( 0, mass * g - up );
				const horiz = new THREE.Vector3( thrust.x, 0, thrust.z );
				const friction = 0.6 * normal;
				const excess = horiz.length() - friction;
				if ( excess > 0 ) hv.addScaledVector( horiz.normalize(), excess / mass * dt );

				// 이륙 판정은 화면의 이륙선(83 mm)과 같은 기준: 추력의 80 % 가 몸무게를 넘을 때
				if ( F * 0.8 > mass * g ) {

					this.setState( 'air' );
					this.velocity.y = 1.5;

				}

			}

			this.velocity.x = hv.x;
			this.velocity.z = hv.z;
			if ( this.state === 'ground' ) this.velocity.y = 0;

			this.moveHorizontal( dt, world );

			const newGround = world.heightAt( this.position.x, this.position.z, this.position.y );

			if ( this.state === 'ground' ) {

				if ( newGround < this.position.y - 0.6 ) {

					this.setState( 'air' ); // 옥상 끝에서 떨어짐

				} else {

					this.position.y = THREE.MathUtils.lerp( this.position.y, newGround, Math.min( 1, dt * 20 ) );

				}

			}

			this.speed = hv.length();

		} else if ( this.state === 'air' ) {

			// 방구 로켓 조종: W/S 기울기, A/D 방향
			const pitchTarget = input.forward > 0 ? 1.05 : ( input.forward < 0 ? - 0.15 : 0.4 );
			this.flightPitch = THREE.MathUtils.lerp( this.flightPitch, farting ? pitchTarget : 0.2, Math.min( 1, dt * 3 ) );
			this.yaw -= input.turn * dt * 1.8;

			this.velocity.y -= g * dt;
			this.velocity.addScaledVector( thrust, dt / mass );
			this.velocity.multiplyScalar( Math.max( 0, 1 - dt * 0.12 ) );

			this.moveHorizontal( dt, world );
			this.position.y += this.velocity.y * dt;

			const floor = world.heightAt( this.position.x, this.position.z, this.position.y );

			if ( this.position.y <= floor ) {

				this.position.y = floor;
				const impact = - this.velocity.y;
				this.velocity.set( 0, 0, 0 );
				this.setState( impact > 7 ? 'down' : 'ground' );
				this.lastImpact = impact;

			}

			this.speed = 0;

		} else {

			// 쓰러짐 / 일어나기
			this.velocity.multiplyScalar( Math.max( 0, 1 - dt * 4 ) );
			this.moveHorizontal( dt, world );
			this.position.y = groundY;
			this.speed = 0;

			if ( this.state === 'down' && this.stateTime > 1.6 ) this.setState( 'getup' );
			else if ( this.state === 'getup' && this.stateTime > 0.9 ) this.setState( 'ground' );

		}

		// ---- 애니메이션 상태 블렌딩
		const k = Math.min( 1, dt * 7 );

		// 춤은 걷기 시작하거나 방구를 뀌거나 날아가면 멈춘다
		if ( this.dancing && ( input.move.lengthSq() > 0.01 || farting || this.state !== 'ground' ) ) this.dancing = false;
		this.danceTime = this.dancing ? this.danceTime + dt : 0;
		this.danceBlend = THREE.MathUtils.lerp( this.danceBlend, this.dancing ? 1 : 0, Math.min( 1, dt * 6 ) );
		this.fartBlend = THREE.MathUtils.lerp( this.fartBlend, farting && this.state === 'ground' ? 1 : 0, Math.min( 1, dt * 10 ) );
		this.flyBlend = THREE.MathUtils.lerp( this.flyBlend, this.state === 'air' ? 1 : 0, k );
		this.downBlend = THREE.MathUtils.lerp( this.downBlend, this.state === 'down' ? 1 : 0, Math.min( 1, dt * ( this.state === 'down' ? 9 : 3 ) ) );
		if ( this.wasFarting && ! farting ) this.relief = 0.01;
		if ( this.relief > 0 ) this.relief += dt * 0.9;
		if ( this.relief > 1 || farting ) this.relief = 0;
		this.wasFarting = farting;

		this.group.rotation.y = this.yaw;

		// 걷기·달리기는 Soldier 애니메이션, 방구·비행·쓰러짐 자세는 포즈 풀이를 그 위에 섞는다
		this.body.locomote( dt, this.speed );
		const relief = this.relief > 0 ? Math.sin( Math.min( 1, this.relief ) * Math.PI ) : 0;
		const procedural = Math.min( 1, Math.max( this.fartBlend, this.flyBlend, this.downBlend, this.danceBlend, this.state === 'getup' ? 1 - this.stateTime / 0.9 : 0, relief * 0.8 ) );

		if ( procedural > 0.002 ) {

			const pose = this.buildPose( dt, fart );
			const r = this.solve( pose );

			// 땅에 발 붙이기 (지상에서만)
			const grounded = this.state === 'ground' ? 1 - this.flyBlend : 0;
			const lowest = Math.min( r.footL, r.footR );
			this.groundOffset = THREE.MathUtils.lerp( this.groundOffset, - lowest * grounded, Math.min( 1, dt * 18 ) );
			if ( this.state !== 'ground' ) this.groundOffset *= Math.max( 0, 1 - dt * 6 );
			const w = procedural;
			this.body.apply( r, { hips: w, spine: w, head: w, armL: w, armR: w, legs: w }, this.groundOffset );

		} else {

			this.groundOffset = 0;

		}

		// 표정
		this.blinkTimer -= dt;
		let open = 1;
		if ( this.blinkTimer < 0.12 ) open = Math.abs( this.blinkTimer - 0.06 ) / 0.06;
		if ( this.blinkTimer < 0 ) this.blinkTimer = 2 + Math.random() * 3;
		const strain = this.fartBlend;
		const surprised = this.flyBlend * ( farting ? 0.2 : 1 );
		this.face.draw( this.state === 'down' ? 0.08 : open * ( 1 + surprised * 0.35 ), strain * 0.9, strain * THREE.MathUtils.clamp( F / 800, 0.2, 1 ) );

		// 분사구 위치와 방향 (월드)
		this.group.updateMatrixWorld( true );
		this.nozzle.getWorldPosition( this.jetOrigin );
		const hipsWorld = this.hipsMount.getWorldQuaternion( new THREE.Quaternion() );
		this.jetDirection.set( 0, - 0.946, - 0.324 ).applyQuaternion( hipsWorld ).normalize();

		// 그림자
		const shadowY = world.heightAt( this.position.x, this.position.z, this.position.y + 0.1 );
		const height = Math.max( 0, this.position.y - shadowY );
		this.shadow.position.set( this.position.x, shadowY + 0.02, this.position.z );
		this.shadow.scale.setScalar( THREE.MathUtils.lerp( 1.1, 2.4, Math.min( 1, height / 20 ) ) * ( this.downBlend > 0.5 ? 1.6 : 1 ) );
		this.shadow.material.opacity = 1 / ( 1 + height * 0.15 );

	}

	setState( state ) {

		this.state = state;
		this.stateTime = 0;

	}

	moveHorizontal( dt, world ) {

		const nx = this.position.x + this.velocity.x * dt;
		const nz = this.position.z + this.velocity.z * dt;
		const y = this.position.y;
		const step = this.state === 'ground' ? 0.45 : 0.05;

		// 건물 벽에 막히면 그 축만 멈춘다
		if ( world.heightAt( nx, this.position.z, y ) <= y + step ) this.position.x = nx;
		else this.velocity.x *= this.state === 'air' ? - 0.3 : 0;

		if ( world.heightAt( this.position.x, nz, y ) <= y + step ) this.position.z = nz;
		else this.velocity.z *= this.state === 'air' ? - 0.3 : 0;

	}

}
