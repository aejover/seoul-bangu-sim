import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { ASSETS, PoseSolver } from './rig.js';

// webgl_animation_skinning_blending 의 Soldier 몸 (Mixamo 뼈대 + Idle/Walk/Run 애니메이션).
// 군복 텍스처는 버리고 정점 색으로 옷을 입힌다 (사진 속 서울 사람들 옷차림).
// 걷기·달리기는 원래 애니메이션을 섞어 쓰고, 방구·비행·반응 같은 자세는 rig.js 의 포즈 풀이를 옮겨 심는다.

const PREFIX = 'mixamorig';

// rig.js 관절 이름 → Mixamo 뼈 (Soldier 는 -z 를 보고 있어서 y 축으로 반 바퀴 돌려 +z 를 보게 한다. 그러면 Left = +x)
const MAP = {
	hips: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head',
	L_shoulder: 'LeftShoulder', L_upperArm: 'LeftArm', L_forearm: 'LeftForeArm', L_hand: 'LeftHand',
	R_shoulder: 'RightShoulder', R_upperArm: 'RightArm', R_forearm: 'RightForeArm', R_hand: 'RightHand',
	L_thigh: 'LeftUpLeg', L_shin: 'LeftLeg', L_foot: 'LeftFoot',
	R_thigh: 'RightUpLeg', R_shin: 'RightLeg', R_foot: 'RightFoot'
};
const REVERSE = Object.fromEntries( Object.entries( MAP ).map( ( [ k, v ] ) => [ v, k ] ) );

function groupOf( name ) {

	if ( /Hand(Thumb|Index|Middle|Ring|Pinky)/.test( name ) ) return 'fingers';
	if ( name === 'Hips' ) return 'hips';
	if ( /Leg|Foot|Toe/.test( name ) ) return 'legs';
	if ( /^Left(Shoulder|Arm|ForeArm|Hand)/.test( name ) ) return 'armL';
	if ( /^Right(Shoulder|Arm|ForeArm|Hand)/.test( name ) ) return 'armR';
	if ( /Neck|Head/.test( name ) ) return 'head';
	return 'spine';

}

const FLIP = new THREE.Matrix4().makeRotationY( Math.PI );
const FLIP_Q = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), Math.PI );

let kitPromise = null;

export function loadSoldier() {

	if ( kitPromise ) return kitPromise;

	kitPromise = ( async () => {

		const gltf = await new GLTFLoader().loadAsync( ASSETS + 'models/gltf/Soldier.glb' );
		const scene = gltf.scene;
		scene.updateMatrixWorld( true );

		const mesh = scene.getObjectByName( 'vanguard_Mesh' );
		const armature = scene.getObjectByName( PREFIX + 'Hips' ).parent;
		const bone = ( n ) => scene.getObjectByName( PREFIX + n );
		const model = ( n ) => new THREE.Vector3().setFromMatrixPosition( bone( n ).matrixWorld ).applyMatrix4( FLIP );

		// 관절 위치 (모델 공간)
		const J = {
			hips: model( 'Hips' ), spine: model( 'Spine' ), chest: model( 'Spine2' ), neck: model( 'Neck' ), head: model( 'Head' )
		};
		J.headEnd = J.head.clone().add( new THREE.Vector3( 0, 0.22, 0 ) );

		for ( const [ s, side ] of [ [ 'L', 'Left' ], [ 'R', 'Right' ] ] ) {

			J[ s + '_shoulder' ] = model( side + 'Shoulder' );
			J[ s + '_upperArm' ] = model( side + 'Arm' );
			J[ s + '_forearm' ] = model( side + 'ForeArm' );
			J[ s + '_hand' ] = model( side + 'Hand' );
			J[ s + '_handEnd' ] = model( side + 'HandMiddle3' );
			J[ s + '_thigh' ] = model( side + 'UpLeg' );
			J[ s + '_shin' ] = model( side + 'Leg' );
			J[ s + '_foot' ] = model( side + 'Foot' );
			J[ s + '_toe' ] = model( side + 'ToeBase' );

		}

		J.anus = J.hips.clone().add( new THREE.Vector3( 0, - 0.11, - 0.12 ) );

		// 뼈 순서 (부모가 먼저), 바인드 자세의 모델 공간 회전과 행렬
		const order = [], parent = {}, source = {}, group = {};
		const bindWorld = new Map(), bindMatrix = new Map();

		bone( 'Hips' ).traverse( ( o ) => {

			if ( ! o.isBone ) return;
			const name = o.name.replace( PREFIX, '' );
			order.push( name );
			parent[ name ] = o.parent.isBone ? o.parent.name.replace( PREFIX, '' ) : null;
			const m = FLIP.clone().multiply( o.matrixWorld );
			bindMatrix.set( name, m );
			bindWorld.set( name, new THREE.Quaternion().setFromRotationMatrix( new THREE.Matrix4().extractRotation( m ) ) );
			// 매핑 안 된 뼈 (Spine1, 손가락, 발가락) 는 가장 가까운 매핑된 조상의 회전을 따른다
			source[ name ] = REVERSE[ name ] || source[ parent[ name ] ];
			group[ name ] = groupOf( name );

		} );

		const armatureMatrix = FLIP.clone().multiply( armature.matrixWorld );
		const armatureQ = new THREE.Quaternion().setFromRotationMatrix( new THREE.Matrix4().extractRotation( armatureMatrix ) );
		const armatureInv = armatureMatrix.clone().invert();

		// 지오메트리: 정점마다 가장 크게 붙은 뼈, 모델 공간 위치. 머리(헬멧)와 바이저는 버린다
		const src = mesh.geometry;
		const g2m = FLIP.clone().multiply( mesh.matrixWorld );
		const m2g = g2m.clone().invert();
		const count = src.attributes.position.count;
		const si = src.attributes.skinIndex, sw = src.attributes.skinWeight;
		const boneNames = mesh.skeleton.bones.map( ( b ) => b.name.replace( PREFIX, '' ) );
		const dominant = new Array( count );
		const mpos = new Float32Array( count * 3 );
		const v = new THREE.Vector3();

		for ( let i = 0; i < count; i ++ ) {

			let best = 0, bw = - 1;
			for ( let k = 0; k < 4; k ++ ) {

				const w = sw.getComponent( i, k );
				if ( w > bw ) {

					bw = w;
					best = si.getComponent( i, k );

				}

			}

			dominant[ i ] = boneNames[ best ];
			v.fromBufferAttribute( src.attributes.position, i ).applyMatrix4( g2m );
			mpos[ i * 3 ] = v.x;
			mpos[ i * 3 + 1 ] = v.y;
			mpos[ i * 3 + 2 ] = v.z;

		}

		const index = [];
		const srcIndex = src.index.array;

		for ( let t = 0; t < srcIndex.length; t += 3 ) {

			const a = srcIndex[ t ], b = srcIndex[ t + 1 ], c = srcIndex[ t + 2 ];
			const head = ( i ) => dominant[ i ] === 'Head' || mpos[ i * 3 + 1 ] > J.head.y + 0.04;
			if ( head( a ) && head( b ) && head( c ) ) continue;

			// 군복의 높은 깃(목 둘레로 삐죽 솟은 조각)도 버린다
			const collar = ( i ) => mpos[ i * 3 + 1 ] > J.neck.y - 0.05 && Math.hypot( mpos[ i * 3 ], mpos[ i * 3 + 2 ] - J.neck.z ) > 0.07 && ! /Arm|Shoulder/.test( dominant[ i ] );
			if ( collar( a ) && collar( b ) && collar( c ) ) continue;
			if ( head( a ) || head( b ) || head( c ) ) {

				// 목 위 경계: 얼굴(스캔 머리)에 가려지는 쪽이면 버린다
				const cy = ( mpos[ a * 3 + 1 ] + mpos[ b * 3 + 1 ] + mpos[ c * 3 + 1 ] ) / 3;
				if ( cy > J.head.y - 0.01 ) continue;

			}

			index.push( a, b, c );

		}

		const geometry = new THREE.BufferGeometry();
		for ( const name of [ 'position', 'normal', 'skinIndex', 'skinWeight' ] ) geometry.setAttribute( name, src.attributes[ name ] );
		geometry.setIndex( index );

		const clips = Object.fromEntries( gltf.animations.map( ( c ) => [ c.name.toLowerCase(), c ] ) );

		const kit = {
			gltf, joints: J, solver: new PoseSolver( J ), order, parent, source, group, bindWorld, bindMatrix, armatureQ, armatureInv,
			geometry, mpos, dominant, m2g, clips, count
		};

		kit.walkSpeed = clipSpeed( kit, clips.walk );
		kit.runSpeed = clipSpeed( kit, clips.run );

		// 머리 관절에서 본 얼굴 스캔 원점 (정수리가 1.8 m 쯤, 얼굴이 몸 앞쪽에 오도록)
		kit.faceOffset = new THREE.Vector3( 0, 0.024, 0.03 );
		return kit;

	} )();

	return kitPromise;

}

// 제자리 걷기 애니메이션의 보폭으로 걷는 속도를 잰다
function clipSpeed( kit, clip ) {

	const scene = cloneSkinned( kit.gltf.scene );
	const mixer = new THREE.AnimationMixer( scene );
	const action = mixer.clipAction( clip );
	action.play();
	const L = scene.getObjectByName( PREFIX + 'LeftFoot' ), R = scene.getObjectByName( PREFIX + 'RightFoot' );
	const a = new THREE.Vector3(), b = new THREE.Vector3();
	let max = 0;

	for ( let k = 0; k < 24; k ++ ) {

		action.time = clip.duration * k / 24;
		mixer.update( 0 );
		scene.updateMatrixWorld( true );
		a.setFromMatrixPosition( L.matrixWorld );
		b.setFromMatrixPosition( R.matrixWorld );
		max = Math.max( max, Math.abs( a.z - b.z ) );

	}

	return 2 * max / clip.duration;

}

// ---------------------------------------------------------------------------
// 옷

export const OUTFITS = {
	male: [
		// 검정 가죽 재킷 + 흰 티 + 와이드 흑청 + 흰 운동화 + 안경
		{ open: true, jacket: 0x151515, inner: 0xf2f2ee, pants: 0x30343c, wide: 0.42, shoes: 0xf2f2ee, belt: 0x111111, glasses: true },
		// 차콜 스웨이드 재킷 + 검정 터틀넥 + 와이드 슬랙스 + 로퍼 + 백팩
		{ open: true, jacket: 0x4a4846, inner: 0x111111, turtle: true, pants: 0x121212, wide: 0.38, shoes: 0x0c0c0c, belt: 0x151515, backpack: true },
		// 회색 후드집업 + 흰 나시 + 흑청 반바지 + 흰 양말 + 모자
		{ open: true, hoodie: true, jacket: 0x8b8e8f, inner: 0xf0f0f0, pants: 0x2b2c31, shorts: true, wide: 0.35, socks: 0xf4f4f4, shoes: 0xcfc4a6, belt: 0x8a5a32, cap: 0xf2f2ee },
		// 검정 반팔 티 + 국방 체크 와이드 팬츠
		{ tee: true, inner: 0x141414, pants: 0x4b5236, wide: 0.45, shoes: 0x222222, belt: 0x111111 },
		// 양복 (남색)
		{ jacket: 0x1c2433, inner: 0xf4f4f4, pants: 0x1c2433, wide: 0.08, shoes: 0x0b0b0b, long: true },
		// 양복 (회색)
		{ jacket: 0x55595e, inner: 0xeef2f7, pants: 0x55595e, wide: 0.08, shoes: 0x1b1410, long: true }
	],
	female: [
		// 오버핏 카키 블레이저 + 하늘색 셔츠 + 플리츠 스커트
		{ jacket: 0x7b7a5e, inner: 0x8fc3ef, cuffs: true, skirt: 0x76755a, long: true, over: 0.09, shoes: 0x2b2b2b },
		// 검정 후드집업 + 갈색 와이드 팬츠 + 초록 비니 + 선글라스
		{ open: true, hoodie: true, jacket: 0x141414, inner: 0xe8e8e8, pants: 0x5a3a28, wide: 0.5, shoes: 0x4a3426, beanie: 0x2f6b46, sunglasses: true },
		// 검정 정장
		{ jacket: 0x202020, inner: 0xf4f4f4, pants: 0x202020, wide: 0.35, shoes: 0x111111, long: true },
		// 아이보리 니트 + 검정 스커트 + 검정 스타킹
		{ knit: true, inner: 0xe9dcc8, skirt: 0x222222, tights: 0x1a1a1a, shoes: 0x111111 },
		// 검정 가죽 재킷 + 연청 와이드
		{ open: true, jacket: 0x161616, inner: 0xf2f2ee, pants: 0x7d94b2, wide: 0.45, shoes: 0xf2f2ee, belt: 0x161616 }
	]
};

const smooth = ( x, e0, e1 ) => {

	const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return t * t * ( 3 - 2 * t );

};

// 점 p 에서 선분 ab 까지 가장 가까운 점
function closest( p, a, b, target ) {

	const ab = _ab.subVectors( b, a );
	const t = THREE.MathUtils.clamp( _ap.subVectors( p, a ).dot( ab ) / ab.lengthSq(), 0, 1 );
	return target.copy( a ).addScaledVector( ab, t );

}

const _ab = new THREE.Vector3(), _ap = new THREE.Vector3(), _c = new THREE.Vector3();

// 옷 입은 몸 지오메트리 (위치와 색만 사람마다 따로)
export function dressedGeometry( kit, outfit, sex, skin ) {

	const J = kit.joints;
	const n = kit.count;
	const base = kit.geometry;
	const position = new Float32Array( n * 3 );
	const colors = new Uint8Array( n * 3 );
	const p = new THREE.Vector3();
	const col = new THREE.Color();
	const female = sex === 'female';
	const waistY = J.hips.y - 0.02;
	const hemY = outfit.long ? J.hips.y - 0.22 : outfit.hoodie || outfit.knit ? J.hips.y - 0.1 : J.hips.y - 0.05;
	const legs = outfit.skirt ? ( outfit.tights ?? skin ) : null;

	for ( let i = 0; i < n; i ++ ) {

		p.set( kit.mpos[ i * 3 ], kit.mpos[ i * 3 + 1 ], kit.mpos[ i * 3 + 2 ] );
		const bone = kit.dominant[ i ];
		const side = p.x > 0 ? 'L' : 'R';
		const isLeg = /UpLeg|Leg$/.test( bone );
		const isArm = /Arm|Shoulder/.test( bone );
		const isHand = /Hand/.test( bone );
		const isFoot = /Foot|Toe/.test( bone );
		const torso = ! isLeg && ! isArm && ! isHand && ! isFoot;
		const y0 = p.y;

		// ---- 모양
		if ( isLeg && ! outfit.skirt ) {

			// 와이드 팬츠: 발목으로 갈수록 통이 넓어진다 (반바지는 허벅지만)
			const axis = bone.includes( 'Up' ) ? closest( p, J[ side + '_thigh' ], J[ side + '_shin' ], _c ) : closest( p, J[ side + '_shin' ], J[ side + '_foot' ], _c );
			const k = outfit.shorts ? ( y0 > J[ side + '_shin' ].y + 0.04 ? 1 + outfit.wide * 0.7 : 1 ) : 1 + ( outfit.wide || 0 ) * smooth( y0, 0.95, 0.12 );
			p.sub( axis ).multiplyScalar( k ).add( axis );

		}

		const over = outfit.over || ( outfit.hoodie ? 0.06 : outfit.jacket ? 0.04 : 0.02 );

		if ( torso ) {

			// 군복 조끼와 허리 주머니 부피를 눌러 평범한 몸으로, 그 위에 상의는 살짝 넉넉하게
			const pouch = Math.exp( - Math.pow( ( y0 - ( J.hips.y + 0.02 ) ) / 0.09, 2 ) );
			const vest = Math.exp( - Math.pow( ( y0 - 1.3 ) / 0.14, 2 ) );
			const k = 1 - 0.13 * pouch - 0.06 * vest + ( y0 > hemY - 0.02 ? over : 0 );
			p.x *= k;
			p.z = ( p.z - J.spine.z ) * ( k - 0.03 * vest ) + J.spine.z;

		} else if ( isArm ) {

			const axis = bone.includes( 'Fore' ) ? closest( p, J[ side + '_forearm' ], J[ side + '_hand' ], _c ) : closest( p, J[ side + '_upperArm' ], J[ side + '_forearm' ], _c );
			p.sub( axis ).multiplyScalar( 1 + over * 2 ).add( axis );

		}

		if ( female && ( torso || isArm ) ) {

			if ( isArm ) p.x -= Math.sign( p.x ) * 0.025;
			else {

				const waist = Math.exp( - Math.pow( ( y0 - 1.12 ) / 0.09, 2 ) );
				const hip = Math.exp( - Math.pow( ( y0 - 0.97 ) / 0.08, 2 ) );
				const shoulder = smooth( y0, 1.36, 1.48 );
				p.x *= 1 - 0.12 * waist + 0.08 * hip - 0.08 * shoulder;
				if ( p.z > J.chest.z + 0.03 ) {

					for ( const sx of [ - 1, 1 ] ) p.z += 0.05 * Math.exp( - ( Math.pow( ( p.x - sx * 0.09 ) / 0.07, 2 ) + Math.pow( ( y0 - 1.33 ) / 0.07, 2 ) ) );

				}

			}

		}

		// ---- 색
		let hex = outfit.jacket ?? outfit.inner;
		// 열린 재킷·후드집업만 앞섶 사이로 안에 입은 옷이 보인다 (몸 메시가 거칠어서 넓게 잡으면 턱받이처럼 번진다)
		const front = outfit.open && p.z > J.spine.z + 0.04 && Math.abs( p.x ) < 0.045 && y0 > hemY + 0.04 && y0 < J.neck.y - 0.04;

		if ( isHand ) hex = skin;
		else if ( isFoot ) hex = outfit.shoes;
		else if ( isLeg || ( torso && y0 < hemY ) ) {

			if ( outfit.skirt ) hex = y0 < 0.1 ? outfit.shoes : legs;
			else if ( outfit.shorts ) hex = y0 > J[ side + '_shin' ].y - 0.06 ? outfit.pants : y0 < 0.3 ? outfit.socks : skin;
			else hex = outfit.pants;

		} else if ( isArm ) {

			if ( outfit.tee ) {

				// 반팔: 위팔 중간부터 살
				const t = bone.includes( 'Fore' ) ? 1 : closest( p, J[ side + '_upperArm' ], J[ side + '_forearm' ], _c ).distanceTo( J[ side + '_upperArm' ] ) / J[ side + '_upperArm' ].distanceTo( J[ side + '_forearm' ] );
				hex = t > 0.45 ? skin : outfit.inner;

			} else {

				hex = outfit.jacket ?? outfit.inner;
				if ( outfit.cuffs && p.distanceTo( J[ side + '_hand' ] ) < 0.06 ) hex = outfit.inner;

			}

		} else if ( ( bone === 'Neck' || y0 > J.neck.y - 0.03 ) && Math.hypot( p.x, p.z - J.neck.z ) < 0.085 ) {

			hex = outfit.turtle || outfit.knit ? outfit.inner : outfit.hoodie ? outfit.jacket : skin;
			if ( outfit.cuffs && p.z > J.neck.z ) hex = outfit.inner; // 셔츠 깃

		} else if ( outfit.tee || outfit.knit ) {

			hex = outfit.inner;

		} else if ( front ) {

			// 열린 앞섶으로 안에 입은 옷이 보인다
			hex = outfit.inner;

		}

		if ( outfit.belt && ! outfit.long && ! outfit.skirt && Math.abs( y0 - waistY ) < 0.014 && ! isArm && ! isHand ) hex = outfit.belt;

		col.setHex( hex );
		colors[ i * 3 ] = Math.round( col.r * 255 );
		colors[ i * 3 + 1 ] = Math.round( col.g * 255 );
		colors[ i * 3 + 2 ] = Math.round( col.b * 255 );

		p.applyMatrix4( kit.m2g );
		position[ i * 3 ] = p.x;
		position[ i * 3 + 1 ] = p.y;
		position[ i * 3 + 2 ] = p.z;

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	g.setAttribute( 'color', new THREE.BufferAttribute( colors, 3, true ) );
	for ( const name of [ 'normal', 'skinIndex', 'skinWeight' ] ) g.setAttribute( name, base.attributes[ name ] );
	g.setIndex( base.index );
	g.computeBoundingSphere();
	return g;

}

// ---------------------------------------------------------------------------
// 사람 한 명의 몸

export class SoldierBody {

	constructor( kit, geometry, material ) {

		this.kit = kit;
		const scene = cloneSkinned( kit.gltf.scene );
		const visor = scene.getObjectByName( 'vanguard_visor' );
		if ( visor ) visor.removeFromParent();
		this.mesh = scene.getObjectByName( 'vanguard_Mesh' );
		this.mesh.geometry = geometry;
		this.mesh.material = material;
		this.mesh.receiveShadow = true;
		this.mesh.frustumCulled = false;

		this.root = new THREE.Group();
		const inner = new THREE.Group();
		inner.rotation.y = Math.PI;
		inner.add( scene );
		this.root.add( inner );

		this.bones = {};
		scene.traverse( ( o ) => {

			if ( o.isBone ) this.bones[ o.name.replace( PREFIX, '' ) ] = o;

		} );

		this.mixer = new THREE.AnimationMixer( scene );
		this.actions = {};

		for ( const name of [ 'idle', 'walk', 'run' ] ) {

			const a = this.mixer.clipAction( kit.clips[ name ] );
			a.play();
			a.setEffectiveWeight( name === 'idle' ? 1 : 0 );
			if ( name !== 'idle' ) a.timeScale = 0; // 걷기·달리기는 발걸음 위상을 직접 맞춘다
			this.actions[ name ] = a;

		}

		this.actions.idle.time = Math.random() * kit.clips.idle.duration;
		this.phase = Math.random();
		this.procWorld = new Map( kit.order.map( ( n ) => [ n, new THREE.Quaternion() ] ) );

	}

	// 뼈에 모델 축으로 정렬된 받침대를 단다 (얼굴, 모자, 분사구 같은 것을 붙이는 곳)
	attach( boneName, at ) {

		const a = new THREE.Object3D();
		const m = this.kit.bindMatrix.get( boneName ).clone().invert().multiply( new THREE.Matrix4().makeTranslation( at.x, at.y, at.z ) );
		m.decompose( a.position, a.quaternion, a.scale );
		this.bones[ boneName ].add( a );
		return a;

	}

	// 걷기 / 달리기 / 서 있기 섞기
	locomote( dt, speed ) {

		const kit = this.kit;
		const walk = THREE.MathUtils.clamp( speed / ( kit.walkSpeed * 0.8 ), 0, 1 );
		const run = THREE.MathUtils.clamp( ( speed - kit.walkSpeed * 1.4 ) / ( kit.runSpeed - kit.walkSpeed * 1.4 ), 0, 1 );
		this.actions.idle.setEffectiveWeight( 1 - walk );
		this.actions.walk.setEffectiveWeight( walk * ( 1 - run ) );
		this.actions.run.setEffectiveWeight( walk * run );

		// 한 걸음 주기에 나아가는 거리로 위상을 진행 (빨리 달리면 다리도 빨라진다)
		const cycle = THREE.MathUtils.lerp( kit.walkSpeed * kit.clips.walk.duration, kit.runSpeed * kit.clips.run.duration, run );
		this.phase = ( this.phase + dt * speed / cycle ) % 1;
		this.actions.walk.time = this.phase * kit.clips.walk.duration;
		this.actions.run.time = this.phase * kit.clips.run.duration;
		this.mixer.update( dt );

	}

	// 포즈 풀이 결과를 뼈에 옮긴다. w 는 부위별 섞는 비율 (0 = 애니메이션 그대로, 1 = 포즈 그대로)
	apply( r, w, groundOffset = 0 ) {

		const kit = this.kit;

		for ( const name of kit.order ) {

			const qw = this.procWorld.get( name ).copy( r.world[ kit.source[ name ] ] ).multiply( kit.bindWorld.get( name ) );
			const weight = w[ kit.group[ name ] ] || 0;
			if ( weight <= 0 ) continue;
			const parentQ = kit.parent[ name ] ? this.procWorld.get( kit.parent[ name ] ) : kit.armatureQ;
			_ql.copy( parentQ ).invert().multiply( qw );
			const bone = this.bones[ name ];
			if ( weight >= 1 ) bone.quaternion.copy( _ql );
			else bone.quaternion.slerp( _ql, weight );

		}

		if ( w.hips > 0 ) {

			_hp.copy( r.pos.hips );
			_hp.y += groundOffset;
			_hp.applyMatrix4( kit.armatureInv );
			this.bones.Hips.position.lerp( _hp, w.hips );

		}

	}

}

const _ql = new THREE.Quaternion();
const _hp = new THREE.Vector3();

export const ALL = { hips: 1, spine: 1, head: 1, armL: 1, armR: 1, legs: 1 };

// ---------------------------------------------------------------------------
// 소품: 치마, 후드, 백팩

let propGeometry = null;

function props() {

	if ( propGeometry ) return propGeometry;

	// 주름치마: 허리에서 무릎까지 퍼지는 원뿔에 주름
	const skirt = new THREE.CylinderGeometry( 0.15, 0.3, 0.5, 64, 4, true );
	const p = skirt.attributes.position;

	for ( let i = 0; i < p.count; i ++ ) {

		const x = p.getX( i ), z = p.getZ( i ), y = p.getY( i );
		const a = Math.atan2( z, x );
		const pleat = 1 + 0.05 * Math.sign( Math.sin( a * 16 ) ) * ( 0.3 + 0.7 * ( 0.25 - y ) );
		p.setXYZ( i, x * pleat, y, z * pleat * 0.82 );

	}

	skirt.computeVertexNormals();

	propGeometry = {
		skirt,
		hood: new THREE.TorusGeometry( 0.12, 0.05, 8, 18, Math.PI ).rotateZ( Math.PI ).rotateX( - 0.5 ),
		backpack: new THREE.BoxGeometry( 0.3, 0.4, 0.13 )
	};

	return propGeometry;

}

const propMaterials = new Map();

function propMaterial( hex ) {

	if ( ! propMaterials.has( hex ) ) propMaterials.set( hex, new THREE.MeshStandardMaterial( { color: hex, roughness: 0.8, side: THREE.DoubleSide } ) );
	return propMaterials.get( hex );

}

export function addProps( body, outfit ) {

	const J = body.kit.joints;
	const g = props();

	if ( outfit.skirt ) {

		const hips = body.attach( 'Hips', J.hips );
		const skirt = new THREE.Mesh( g.skirt, propMaterial( outfit.skirt ) );
		skirt.position.set( 0, - 0.3, - 0.005 );
		hips.add( skirt );

	}

	if ( outfit.hoodie || outfit.backpack ) {

		const chest = body.attach( 'Spine2', J.chest );

		if ( outfit.hoodie ) {

			const hood = new THREE.Mesh( g.hood, propMaterial( outfit.jacket ) );
			hood.position.set( 0, J.neck.y - J.chest.y + 0.02, - 0.1 );
			chest.add( hood );

		}

		if ( outfit.backpack ) {

			const pack = new THREE.Mesh( g.backpack, propMaterial( 0x1a1a1a ) );
			pack.position.set( 0, - 0.08, - 0.2 );
			chest.add( pack );

		}

	}

}
