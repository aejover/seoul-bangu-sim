import * as THREE from 'three/webgpu';

// three.js 저장소의 r187 태그로 고정한 CDN (threejs.org 는 릴리스마다 파일이 바뀔 수 있다)
export const ASSETS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r187/examples/';

// 포즈를 계산하는 19개 관절 (이름, 부모, 시작 관절, 끝 관절).
// 실제 뼈대(soldier.js 의 Mixamo 뼈)에는 여기서 나온 회전을 옮겨 심는다.
export const BONES = [
	[ 'hips', null, 'hips', 'spine' ],
	[ 'spine', 'hips', 'spine', 'chest' ],
	[ 'chest', 'spine', 'chest', 'neck' ],
	[ 'neck', 'chest', 'neck', 'head' ],
	[ 'head', 'neck', 'head', 'headEnd' ],
	[ 'L_shoulder', 'chest', 'L_shoulder', 'L_upperArm' ],
	[ 'L_upperArm', 'L_shoulder', 'L_upperArm', 'L_forearm' ],
	[ 'L_forearm', 'L_upperArm', 'L_forearm', 'L_hand' ],
	[ 'L_hand', 'L_forearm', 'L_hand', 'L_handEnd' ],
	[ 'R_shoulder', 'chest', 'R_shoulder', 'R_upperArm' ],
	[ 'R_upperArm', 'R_shoulder', 'R_upperArm', 'R_forearm' ],
	[ 'R_forearm', 'R_upperArm', 'R_forearm', 'R_hand' ],
	[ 'R_hand', 'R_forearm', 'R_hand', 'R_handEnd' ],
	[ 'L_thigh', 'hips', 'L_thigh', 'L_shin' ],
	[ 'L_shin', 'L_thigh', 'L_shin', 'L_foot' ],
	[ 'L_foot', 'L_shin', 'L_foot', 'L_toe' ],
	[ 'R_thigh', 'hips', 'R_thigh', 'R_shin' ],
	[ 'R_shin', 'R_thigh', 'R_shin', 'R_foot' ],
	[ 'R_foot', 'R_shin', 'R_foot', 'R_toe' ]
];

const BONE_INDEX = Object.fromEntries( BONES.map( ( b, i ) => [ b[ 0 ], i ] ) );

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

// 아래(0,-1,0)에서 앞(+z)으로 pitch, 바깥(side 쪽 x)으로 out 만큼 벌린 방향
export function limb( pitch, out, side, target = new THREE.Vector3() ) {

	const c = Math.cos( pitch );
	return target.set( side * Math.sin( out ) * c, - Math.cos( out ) * c, Math.sin( pitch ) ).normalize();

}

// ---------------------------------------------------------------------------
// 포즈 풀이: 관절 위치(모델 공간, +z 정면, 발바닥 y=0)만 있으면 어떤 뼈대든 쓸 수 있다.
// 결과 world[이름] 은 처음 자세(바인드)에서 얼마나 돌았는지, pos[이름] 은 관절 위치.

export class PoseSolver {

	constructor( joints ) {

		this.joints = joints;
		this.bind = {};

		for ( const [ name, parent, head, tail ] of BONES ) {

			const offset = parent ? joints[ head ].clone().sub( joints[ BONES[ BONE_INDEX[ parent ] ][ 2 ] ] ) : joints[ head ].clone();
			this.bind[ name ] = { offset, dir: joints[ tail ].clone().sub( joints[ head ] ).normalize(), head: joints[ head ].clone() };

		}

		this.restAnkle = { L: joints.L_foot.y, R: joints.R_foot.y };
		this.restToe = { L: joints.L_toe.y, R: joints.R_toe.y };
		this.toeLength = joints.L_toe.distanceTo( joints.L_foot );
		this.hipsRest = joints.hips.clone();
		this.leg = { thigh: joints.L_thigh.distanceTo( joints.L_shin ), shin: joints.L_shin.distanceTo( joints.L_foot ) };
		this.arm = { upper: joints.L_upperArm.distanceTo( joints.L_forearm ), fore: joints.L_forearm.distanceTo( joints.L_hand ) };

	}

	solve( pose ) {

		const world = {};
		const pos = {};

		const set = ( name, worldQuat ) => {

			const parent = BONES[ BONE_INDEX[ name ] ][ 1 ];
			world[ name ] = worldQuat.clone();
			if ( parent ) pos[ name ] = this.bind[ name ].offset.clone().applyQuaternion( world[ parent ] ).add( pos[ parent ] );

		};

		const local = ( name, euler ) => {

			const parent = BONES[ BONE_INDEX[ name ] ][ 1 ];
			_q.setFromEuler( euler );
			set( name, world[ parent ].clone().multiply( _q ) );

		};

		// 뼈가 dir(모델 공간) 을 향하도록. 부모의 비틀림을 이어받는다
		const aim = ( name, dir ) => {

			const parent = BONES[ BONE_INDEX[ name ] ][ 1 ];
			const qp = world[ parent ];
			_v.copy( this.bind[ name ].dir ).applyQuaternion( qp );
			_q2.setFromUnitVectors( _v, dir );
			set( name, _q2.multiply( qp ) );

		};

		pos.hips = this.hipsRest.clone().add( pose.hipsOffset );
		_q.setFromEuler( pose.hips );
		set( 'hips', _q.clone() );

		local( 'spine', pose.spine );
		local( 'chest', pose.chest );
		local( 'neck', pose.neck );
		local( 'head', pose.head );

		const chest = world.chest;

		for ( const s of [ 'L', 'R' ] ) {

			local( s + '_shoulder', pose[ s + '_shoulder' ] );
			// 팔은 가슴 기준 방향 (armWorld 면 모델 공간 방향)
			const armFrame = pose.armWorld ? _identity : chest;
			aim( s + '_upperArm', pose[ s + '_upperArm' ].clone().applyQuaternion( armFrame ) );
			aim( s + '_forearm', pose[ s + '_forearm' ].clone().applyQuaternion( armFrame ) );
			local( s + '_hand', pose[ s + '_hand' ] );

			// 다리는 모델 공간 방향 (골반을 숙여도 다리는 땅을 딛도록)
			const legFrame = pose.legFrame;
			aim( s + '_thigh', pose[ s + '_thigh' ].clone().applyQuaternion( legFrame ) );
			aim( s + '_shin', pose[ s + '_shin' ].clone().applyQuaternion( legFrame ) );
			aim( s + '_foot', pose[ s + '_foot' ].clone().applyQuaternion( legFrame ) );

		}

		// 발이 땅에 닿도록 골반 높이 보정값
		const footBottom = ( s ) => {

			const ankle = pos[ s + '_foot' ];
			const toe = this.bind[ s + '_foot' ].dir.clone().applyQuaternion( world[ s + '_foot' ] ).multiplyScalar( this.toeLength ).add( ankle );
			return Math.min( ankle.y - this.restAnkle[ s ] + 0.005, toe.y - this.restToe[ s ] );

		};

		return { footL: footBottom( 'L' ), footR: footBottom( 'R' ), pos, world };

	}

	// 두 마디 IK: 엉덩이에서 발목 target 으로, 무릎은 knee 쪽으로 굽힌다
	legIK( hip, target, knee ) {

		return twoBoneIK( hip, target, knee, this.leg.thigh, this.leg.shin );

	}

	armIK( shoulder, target, elbow ) {

		const r = twoBoneIK( shoulder, target, elbow, this.arm.upper, this.arm.fore );
		return { upper: r.thigh, fore: r.shin };

	}

}

const _identity = new THREE.Quaternion();

function twoBoneIK( hip, target, knee, a, b ) {

	const d = target.clone().sub( hip );
	const len = Math.min( d.length(), ( a + b ) * 0.999 );
	d.normalize();
	const cosA = ( a * a + len * len - b * b ) / ( 2 * a * len );
	const angle = Math.acos( THREE.MathUtils.clamp( cosA, - 1, 1 ) );
	const side = knee.clone().addScaledVector( d, - knee.dot( d ) ).normalize();
	const thigh = d.clone().multiplyScalar( Math.cos( angle ) ).addScaledVector( side, Math.sin( angle ) ).normalize();
	const kneePos = hip.clone().addScaledVector( thigh, a );
	const shin = hip.clone().addScaledVector( d, len ).sub( kneePos ).normalize();
	return { thigh, shin };

}

// ---------------------------------------------------------------------------
// 서기 / 걷기 / 달리기 기본 포즈

export function emptyPose() {

	return {
		hipsOffset: new THREE.Vector3(),
		hips: new THREE.Euler(),
		spine: new THREE.Euler(), chest: new THREE.Euler(), neck: new THREE.Euler(), head: new THREE.Euler(),
		L_shoulder: new THREE.Euler(), R_shoulder: new THREE.Euler(),
		L_hand: new THREE.Euler(), R_hand: new THREE.Euler(),
		legFrame: new THREE.Quaternion()
	};

}

export function walkPose( t, speed, phase ) {

	const P = emptyPose();

	const run = THREE.MathUtils.clamp( ( speed - 2.2 ) / 3, 0, 1 );
	const move = THREE.MathUtils.clamp( speed / 1.4, 0, 1 );
	const ph = phase;
	const breathe = Math.sin( t * 1.6 ) * 0.012;

	const swingAmp = THREE.MathUtils.lerp( 0.42, 0.8, run ) * move;
	const kneeAmp = THREE.MathUtils.lerp( 0.75, 1.5, run ) * move;

	for ( const [ s, side, off ] of [ [ 'L', 1, 0 ], [ 'R', - 1, Math.PI ] ] ) {

		const p = ph + off;
		const swing = Math.sin( p ) * swingAmp;
		const knee = 0.06 + Math.max( 0, Math.sin( p + 1.25 ) ) * kneeAmp;
		const thighPitch = swing;
		P[ s + '_thigh' ] = limb( thighPitch, 0.055, side );
		P[ s + '_shin' ] = limb( thighPitch - knee, 0.03, side );
		const footPitch = - 0.3 + Math.max( 0, - Math.sin( p ) ) * 0.25 * move - Math.max( 0, Math.sin( p + 1.6 ) ) * 0.35 * move;
		P[ s + '_foot' ] = new THREE.Vector3( side * 0.1, Math.sin( footPitch ), Math.cos( footPitch ) ).normalize();

		// 팔은 반대 다리와 함께 흔든다
		const armSwing = - Math.sin( p ) * THREE.MathUtils.lerp( 0.45, 0.95, run ) * move;
		P[ s + '_upperArm' ] = limb( armSwing + 0.05, 0.13 + breathe, side );
		const elbow = THREE.MathUtils.lerp( 0.25, 1.5, run * move ) + Math.max( 0, armSwing ) * 0.5;
		P[ s + '_forearm' ] = limb( armSwing + elbow, 0.08, side );

	}

	P.hips.set( run * 0.14, Math.sin( ph ) * 0.12 * move, 0 );
	P.spine.set( run * 0.1 + breathe, - Math.sin( ph ) * 0.06 * move, 0 );
	P.chest.set( breathe * 2, - Math.sin( ph ) * 0.08 * move, 0 );
	P.neck.set( - run * 0.12, 0, 0 );
	P.head.set( - run * 0.08, Math.sin( t * 0.37 ) * 0.15 * ( 1 - move ), 0 );

	return P;

}

export const lerpV = ( a, b, t ) => a.clone().lerp( b, t ).normalize();

// 발밑 동그란 그림자 텍스처
let shadowTexture = null;

export function blobShadowTexture() {

	if ( shadowTexture ) return shadowTexture;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = 64;
	const ctx = canvas.getContext( '2d' );
	const gradient = ctx.createRadialGradient( 32, 32, 0, 32, 32, 32 );
	gradient.addColorStop( 0, 'rgba(0,0,0,0.55)' );
	gradient.addColorStop( 1, 'rgba(0,0,0,0)' );
	ctx.fillStyle = gradient;
	ctx.fillRect( 0, 0, 64, 64 );
	shadowTexture = new THREE.CanvasTexture( canvas );
	return shadowTexture;

}
