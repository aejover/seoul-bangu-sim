import * as THREE from 'three/webgpu';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// three.js 저장소의 r187 태그로 고정한 CDN (threejs.org 는 릴리스마다 파일이 바뀔 수 있다)
export const ASSETS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r187/examples/';

// webgl_loader_obj 의 male02 를 원본 좌표(cm, +z 가 정면)에서 보고 잡은 관절 위치
export const J = {
	hips: [ 2, 95, 2 ], spine: [ 2, 110, 2 ], chest: [ 2, 128, 1 ], neck: [ 2, 151, 0 ], head: [ 2, 160, 1 ], headEnd: [ 2, 183, 1 ],
	L_shoulder: [ 8, 147, 0 ], L_upperArm: [ 19, 145, - 1 ], L_forearm: [ 27, 118, - 2 ], L_hand: [ 26, 100, 5 ], L_handEnd: [ 25, 85, 13 ],
	R_shoulder: [ - 4, 147, 0 ], R_upperArm: [ - 16, 145, - 2 ], R_forearm: [ - 21, 122, - 19 ], R_hand: [ - 20, 108, - 3 ], R_handEnd: [ - 19, 99, 11 ],
	L_thigh: [ 12, 92, 2 ], L_shin: [ 19.5, 50, - 2.5 ], L_foot: [ 26.5, 9, - 6 ], L_toe: [ 35, 2, 10 ],
	R_thigh: [ - 8.5, 92, 2.5 ], R_shin: [ - 16.7, 50, - 0.5 ], R_foot: [ - 24.5, 9, - 4 ], R_toe: [ - 34, 2, 11 ],
	anus: [ 2, 86, - 9 ]
};

// 발 사이 바닥이 모델 원점
const ORIGIN = [ 2, 0.4, 2 ];
export const toModel = ( p ) => new THREE.Vector3( ( p[ 0 ] - ORIGIN[ 0 ] ) * 0.01, ( p[ 1 ] - ORIGIN[ 1 ] ) * 0.01, ( p[ 2 ] - ORIGIN[ 2 ] ) * 0.01 );

// 이름, 부모, 시작 관절, 끝 관절, 살 두께(cm), 부모와 섞이는 폭(cm)
export const BONES = [
	[ 'hips', null, 'hips', 'spine', 15, 0 ],
	[ 'spine', 'hips', 'spine', 'chest', 14, 10 ],
	[ 'chest', 'spine', 'chest', 'neck', 15, 10 ],
	[ 'neck', 'chest', 'neck', 'head', 6, 5 ],
	[ 'head', 'neck', 'head', 'headEnd', 10, 3 ],
	[ 'L_shoulder', 'chest', 'L_shoulder', 'L_upperArm', 7, 5 ],
	[ 'L_upperArm', 'L_shoulder', 'L_upperArm', 'L_forearm', 6.5, 7 ],
	[ 'L_forearm', 'L_upperArm', 'L_forearm', 'L_hand', 5.5, 6 ],
	[ 'L_hand', 'L_forearm', 'L_hand', 'L_handEnd', 4.5, 2.5 ],
	[ 'R_shoulder', 'chest', 'R_shoulder', 'R_upperArm', 7, 5 ],
	[ 'R_upperArm', 'R_shoulder', 'R_upperArm', 'R_forearm', 6.5, 7 ],
	[ 'R_forearm', 'R_upperArm', 'R_forearm', 'R_hand', 5.5, 6 ],
	[ 'R_hand', 'R_forearm', 'R_hand', 'R_handEnd', 4.5, 2.5 ],
	[ 'L_thigh', 'hips', 'L_thigh', 'L_shin', 9, 16 ],
	[ 'L_shin', 'L_thigh', 'L_shin', 'L_foot', 7, 7 ],
	[ 'L_foot', 'L_shin', 'L_foot', 'L_toe', 6, 3 ],
	[ 'R_thigh', 'hips', 'R_thigh', 'R_shin', 9, 16 ],
	[ 'R_shin', 'R_thigh', 'R_shin', 'R_foot', 7, 7 ],
	[ 'R_foot', 'R_shin', 'R_foot', 'R_toe', 6, 3 ]
];

const BONE_INDEX = Object.fromEntries( BONES.map( ( b, i ) => [ b[ 0 ], i ] ) );
const sideOf = ( name ) => name.startsWith( 'L_' ) ? 1 : ( name.startsWith( 'R_' ) ? - 1 : 0 );

// ---------------------------------------------------------------------------
// 자동 스키닝: 뼈 축까지의 거리로 확실한 정점을 고른 뒤, 메시 표면을 따라
// (측지 거리) 라벨을 퍼뜨린다. 팔과 몸통이 붙어 있어도 표면이 이어진 쪽으로만
// 번지므로 겨드랑이가 엉뚱한 뼈에 붙지 않는다. 마지막으로 관절 부근을 부드럽게 섞는다.

function segmentInfo( p, a, b ) {

	const abx = b[ 0 ] - a[ 0 ], aby = b[ 1 ] - a[ 1 ], abz = b[ 2 ] - a[ 2 ];
	const len2 = abx * abx + aby * aby + abz * abz;
	const t = ( ( p[ 0 ] - a[ 0 ] ) * abx + ( p[ 1 ] - a[ 1 ] ) * aby + ( p[ 2 ] - a[ 2 ] ) * abz ) / len2;
	const tc = Math.min( 1, Math.max( 0, t ) );
	const dx = p[ 0 ] - ( a[ 0 ] + abx * tc ), dy = p[ 1 ] - ( a[ 1 ] + aby * tc ), dz = p[ 2 ] - ( a[ 2 ] + abz * tc );
	return { d: Math.sqrt( dx * dx + dy * dy + dz * dz ), along: t * Math.sqrt( len2 ) };

}

function smooth( e0, e1, x ) {

	const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return t * t * ( 3 - 2 * t );

}

// 코트 몸통이 차지하는 상자 (팔은 이 바깥에 매달려 있다)
const TORSO_BOX = { x0: - 13.5, x1: 16.5, y0: 92, y1: 153, z0: - 10.5, z1: 19 };
const isArm = ( name ) => /Arm|forearm|hand/.test( name );

function allowedFor( p, allowed ) {

	// 몸 중심선 반대편 팔다리 뼈는 후보에서 빼고, 몸통 안쪽 정점은 팔에 붙이지 않는다
	const cx = J.hips[ 0 ];
	const b = TORSO_BOX;
	const inTorso = p[ 0 ] > b.x0 && p[ 0 ] < b.x1 && p[ 1 ] > b.y0 && p[ 1 ] < b.y1 && p[ 2 ] > b.z0 && p[ 2 ] < b.z1;

	return allowed.filter( ( i ) => {

		const name = BONES[ i ][ 0 ];
		const s = sideOf( name );
		if ( inTorso && isArm( name ) && allowed.length > 2 ) return false;
		return s === 0 || ( s > 0 ? p[ 0 ] > cx - 1 : p[ 0 ] < cx + 1 );

	} );

}

function boneWeights( p, label, allowed ) {

	const [ name, parent, head, tail, , blend ] = BONES[ label ];
	const w = new Map();

	// 부모와의 관절
	let wParent = 0;

	if ( parent && blend > 0 ) {

		const { along } = segmentInfo( p, J[ head ], J[ tail ] );
		wParent = 1 - smooth( - blend, blend, along );
		w.set( BONE_INDEX[ parent ], wParent );

	}

	// 가장 가까운 자식과의 관절
	let wChild = 0;
	let best = null, bestD = Infinity;

	for ( const i of allowed ) {

		if ( BONES[ i ][ 1 ] !== name ) continue;
		const { d } = segmentInfo( p, J[ BONES[ i ][ 2 ] ], J[ BONES[ i ][ 3 ] ] );
		if ( d < bestD ) {

			bestD = d;
			best = i;

		}

	}

	if ( best !== null ) {

		const [ , , cHead, cTail, , cBlend ] = BONES[ best ];
		const { along } = segmentInfo( p, J[ cHead ], J[ cTail ] );
		wChild = smooth( - cBlend, cBlend, along );
		if ( wChild > 0.001 ) w.set( best, wChild );

	}

	let wSelf = 1 - wParent - wChild;

	if ( wSelf < 0 ) {

		// 짧은 뼈에서 양쪽 관절이 겹칠 때
		const s = wParent + wChild;
		for ( const [ k, v ] of w ) w.set( k, v / s );
		wSelf = 0;

	}

	w.set( label, ( w.get( label ) || 0 ) + wSelf );
	return w;

}

class MinHeap {

	constructor() {

		this.items = [];

	}

	push( d, v ) {

		const a = this.items;
		a.push( [ d, v ] );
		let i = a.length - 1;
		while ( i > 0 ) {

			const p = ( i - 1 ) >> 1;
			if ( a[ p ][ 0 ] <= a[ i ][ 0 ] ) break;
			[ a[ p ], a[ i ] ] = [ a[ i ], a[ p ] ];
			i = p;

		}

	}

	pop() {

		const a = this.items;
		const top = a[ 0 ];
		const last = a.pop();
		if ( a.length > 0 ) {

			a[ 0 ] = last;
			let i = 0;
			for ( ;; ) {

				const l = i * 2 + 1, r = l + 1;
				let m = i;
				if ( l < a.length && a[ l ][ 0 ] < a[ m ][ 0 ] ) m = l;
				if ( r < a.length && a[ r ][ 0 ] < a[ m ][ 0 ] ) m = r;
				if ( m === i ) break;
				[ a[ m ], a[ i ] ] = [ a[ i ], a[ m ] ];
				i = m;

			}

		}

		return top;

	}

	get size() {

		return this.items.length;

	}

}

function skinPart( geometry, allowedNames ) {

	const position = geometry.attributes.position;
	const count = position.count;
	const allowed = allowedNames.map( ( n ) => BONE_INDEX[ n ] );

	// 같은 자리의 정점을 하나로 묶어 연결 정보를 만든다 (OBJLoader 는 삼각형마다 정점을 따로 만든다)
	const ids = new Int32Array( count );
	const keys = new Map();
	const verts = [];

	for ( let i = 0; i < count; i ++ ) {

		const x = position.getX( i ), y = position.getY( i ), z = position.getZ( i );
		const key = `${ Math.round( x * 50 ) },${ Math.round( y * 50 ) },${ Math.round( z * 50 ) }`;
		let id = keys.get( key );
		if ( id === undefined ) {

			id = verts.length;
			keys.set( key, id );
			verts.push( [ x, y, z ] );

		}

		ids[ i ] = id;

	}

	const n = verts.length;
	const adjacency = Array.from( { length: n }, () => [] );
	const link = ( a, b ) => {

		if ( a === b ) return;
		const pa = verts[ a ], pb = verts[ b ];
		const d = Math.hypot( pa[ 0 ] - pb[ 0 ], pa[ 1 ] - pb[ 1 ], pa[ 2 ] - pb[ 2 ] );
		adjacency[ a ].push( b, d );
		adjacency[ b ].push( a, d );

	};

	for ( let t = 0; t < count; t += 3 ) {

		link( ids[ t ], ids[ t + 1 ] );
		link( ids[ t + 1 ], ids[ t + 2 ] );
		link( ids[ t + 2 ], ids[ t ] );

	}

	// 뼈 축까지의 정규화 거리
	const label = new Int16Array( n ).fill( - 1 );
	const nearest = new Int16Array( n );
	const dist = new Float32Array( n ).fill( Infinity );
	const heap = new MinHeap();
	const candidates = [];

	for ( let v = 0; v < n; v ++ ) {

		const p = verts[ v ];
		const list = allowedFor( p, allowed );
		candidates.push( list );

		let b1 = - 1, d1 = Infinity, d2 = Infinity;

		for ( const i of list ) {

			const [ , , head, tail, radius ] = BONES[ i ];
			const d = segmentInfo( p, J[ head ], J[ tail ] ).d / radius;

			if ( d < d1 ) {

				d2 = d1;
				d1 = d;
				b1 = i;

			} else if ( d < d2 ) d2 = d;

		}

		nearest[ v ] = b1;

		if ( d1 < 1.5 && d1 < 0.65 * d2 ) {

			label[ v ] = b1;
			dist[ v ] = 0;
			heap.push( 0, v );

		}

	}

	// 표면을 따라 라벨 확장 (다익스트라)
	while ( heap.size > 0 ) {

		const [ d, v ] = heap.pop();
		if ( d > dist[ v ] ) continue;
		const adj = adjacency[ v ];

		for ( let k = 0; k < adj.length; k += 2 ) {

			const u = adj[ k ], nd = d + adj[ k + 1 ];
			if ( nd < dist[ u ] && candidates[ u ].includes( label[ v ] ) ) {

				dist[ u ] = nd;
				label[ u ] = label[ v ];
				heap.push( nd, u );

			}

		}

	}

	const skinIndex = new Uint16Array( count * 4 );
	const skinWeight = new Float32Array( count * 4 );
	const cache = new Map();

	for ( let i = 0; i < count; i ++ ) {

		const v = ids[ i ];
		let entries = cache.get( v );

		if ( entries === undefined ) {

			const l = label[ v ] >= 0 ? label[ v ] : nearest[ v ];
			entries = [ ...boneWeights( verts[ v ], l, candidates[ v ] ) ].sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).slice( 0, 4 );
			const sum = entries.reduce( ( s, e ) => s + e[ 1 ], 0 );
			entries = entries.map( ( [ b, w ] ) => [ b, w / sum ] );
			cache.set( v, entries );

		}

		for ( let k = 0; k < entries.length; k ++ ) {

			skinIndex[ i * 4 + k ] = entries[ k ][ 0 ];
			skinWeight[ i * 4 + k ] = entries[ k ][ 1 ];

		}

	}

	geometry.setAttribute( 'skinIndex', new THREE.Uint16BufferAttribute( skinIndex, 4 ) );
	geometry.setAttribute( 'skinWeight', new THREE.Float32BufferAttribute( skinWeight, 4 ) );

	return label;

}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

// 아래(0,-1,0)에서 앞(+z)으로 pitch, 바깥(side 쪽 x)으로 out 만큼 벌린 방향
export function limb( pitch, out, side, target = new THREE.Vector3() ) {

	const c = Math.cos( pitch );
	return target.set( side * Math.sin( out ) * c, - Math.cos( out ) * c, Math.sin( pitch ) ).normalize();

}

// ---------------------------------------------------------------------------
// male02 몸 (머리 빼고) 을 불러와 한 번만 스키닝한다. 나와 행인들이 같이 쓴다

let bodyPromise = null;

export function loadBody() {

	if ( bodyPromise ) return bodyPromise;

	bodyPromise = ( async () => {

		const object = await new OBJLoader().loadAsync( ASSETS + 'models/obj/male02/male02.obj' );

		// 머리(얼굴, 머리카락)는 빼고 몸통, 손, 발만 쓴다
		const parts = [];

		object.traverse( ( child ) => {

			if ( ! child.isMesh ) return;
			const g = child.geometry;
			g.computeBoundingBox();
			const box = g.boundingBox;
			if ( g.attributes.position.count < 20 || box.min.y > 150 ) return;

			const cx = ( box.min.x + box.max.x ) / 2;
			const side = cx > J.hips[ 0 ] ? 'L' : 'R';
			let kind = 'body';
			if ( box.max.y < 20 ) kind = 'foot';
			else if ( box.max.y < 120 && box.min.y > 70 ) kind = 'hand';

			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute( 'position', g.attributes.position.clone() );
			geometry.setAttribute( 'normal', g.attributes.normal.clone() );
			geometry.setAttribute( 'uv', g.attributes.uv.clone() );

			// 몸통 메시(옷)는 손·발·머리 뼈를 쓰지 않는다 (손과 발은 따로 된 메시)
			const all = BONES.map( ( b ) => b[ 0 ] ).filter( ( n ) => ! /hand|foot|head/.test( n ) );
			const allowed = kind === 'body' ? all :
				kind === 'hand' ? [ side + '_hand', side + '_forearm' ] :
					[ side + '_foot', side + '_shin' ];

			skinPart( geometry, allowed );
			parts.push( geometry );

		} );

		const geometry = mergeGeometries( parts );
		geometry.translate( - ORIGIN[ 0 ], - ORIGIN[ 1 ], - ORIGIN[ 2 ] );
		geometry.scale( 0.01, 0.01, 0.01 );
		geometry.computeBoundingSphere();
		return geometry;

	} )();

	return bodyPromise;

}

// 정점마다 가장 크게 붙은 뼈 이름 (옷 색칠용)
export function dominantBone( geometry, i ) {

	return BONES[ geometry.attributes.skinIndex.getX( i ) ][ 0 ];

}

// ---------------------------------------------------------------------------
// 뼈대 하나 + 그 뼈대로 움직이는 SkinnedMesh

export class Rig {

	constructor( geometry, material ) {

		this.bones = {};
		this.bind = {};
		const bones = [];

		for ( const [ name, parent, head, tail ] of BONES ) {

			const bone = new THREE.Bone();
			bone.name = name;
			const headPos = toModel( J[ head ] );
			const tailPos = toModel( J[ tail ] );

			if ( parent ) {

				bone.position.copy( headPos ).sub( toModel( J[ BONES[ BONE_INDEX[ parent ] ][ 2 ] ] ) );
				this.bones[ parent ].add( bone );

			} else {

				bone.position.copy( headPos );

			}

			this.bones[ name ] = bone;
			this.bind[ name ] = {
				offset: bone.position.clone(),
				dir: tailPos.clone().sub( headPos ).normalize(),
				head: headPos
			};
			bones.push( bone );

		}

		const mesh = new THREE.SkinnedMesh( geometry, material );
		mesh.frustumCulled = false;
		mesh.add( this.bones.hips );
		mesh.bind( new THREE.Skeleton( bones ) );
		this.mesh = mesh;

		this.restAnkle = { L: this.bind.L_foot.head.y, R: this.bind.R_foot.head.y };
		this.restToe = { L: toModel( J.L_toe ).y, R: toModel( J.R_toe ).y };
		this.hipsRest = this.bind.hips.head.clone();

	}

	// 포즈 계산: 몸통은 부모 기준 회전, 팔다리는 원하는 방향으로 겨눈다
	solve( pose ) {

		const world = {};
		const pos = {};

		const set = ( name, worldQuat ) => {

			const bone = this.bones[ name ];
			const parent = BONES[ BONE_INDEX[ name ] ][ 1 ];
			world[ name ] = worldQuat.clone();

			if ( parent ) {

				bone.quaternion.copy( world[ parent ] ).invert().multiply( worldQuat );
				pos[ name ] = this.bind[ name ].offset.clone().applyQuaternion( world[ parent ] ).add( pos[ parent ] );

			} else {

				bone.quaternion.copy( worldQuat );

			}

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

		// 골반
		pos.hips = this.hipsRest.clone().add( pose.hipsOffset );
		this.bones.hips.position.copy( pos.hips );
		_q.setFromEuler( pose.hips );
		set( 'hips', _q.clone() );

		local( 'spine', pose.spine );
		local( 'chest', pose.chest );
		local( 'neck', pose.neck );
		local( 'head', pose.head );

		const chest = world.chest;

		for ( const s of [ 'L', 'R' ] ) {

			local( s + '_shoulder', pose[ s + '_shoulder' ] );
			// 팔은 가슴 기준 방향 (armFrame 을 주면 모델 공간 방향)
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

		// 발이 땅에 닿도록 골반 높이 보정
		const footBottom = ( s ) => {

			const ankle = pos[ s + '_foot' ];
			const toe = this.bind[ s + '_foot' ].dir.clone().applyQuaternion( world[ s + '_foot' ] ).multiplyScalar( toModel( J[ s + '_toe' ] ).distanceTo( toModel( J[ s + '_foot' ] ) ) ).add( ankle );
			return Math.min( ankle.y - this.restAnkle[ s ] + 0.005, toe.y - this.restToe[ s ] );

		};

		return { footL: footBottom( 'L' ), footR: footBottom( 'R' ), pos, world };

	}

}

const _identity = new THREE.Quaternion();

// 골반 관절에서 본 허벅지 시작점 (모델 공간, 회전 전)
export function thighOffset( side ) {

	return toModel( J[ side + '_thigh' ] ).sub( toModel( J.hips ) );

}

export const LEG = {
	thigh: toModel( J.L_thigh ).distanceTo( toModel( J.L_shin ) ),
	shin: toModel( J.L_shin ).distanceTo( toModel( J.L_foot ) )
};

export const ARM = {
	upper: toModel( J.L_upperArm ).distanceTo( toModel( J.L_forearm ) ),
	fore: toModel( J.L_forearm ).distanceTo( toModel( J.L_hand ) )
};

// 두 마디 IK: 엉덩이 hip 에서 발목 target 으로, 무릎은 knee 쪽으로 굽힌다. 방향 두 개를 돌려준다
export function legIK( hip, target, knee ) {

	return twoBoneIK( hip, target, knee, LEG.thigh, LEG.shin );

}

export function armIK( shoulder, target, elbow ) {

	const r = twoBoneIK( shoulder, target, elbow, ARM.upper, ARM.fore );
	return { upper: r.thigh, fore: r.shin };

}

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
		P[ s + '_foot' ] = new THREE.Vector3( side * 0.22, Math.sin( footPitch ), Math.cos( footPitch ) ).normalize();

		// 팔은 반대 다리와 함께 흔든다
		const armSwing = - Math.sin( p ) * THREE.MathUtils.lerp( 0.45, 0.95, run ) * move;
		P[ s + '_upperArm' ] = limb( armSwing + 0.05, 0.13 + breathe, side );
		const elbow = THREE.MathUtils.lerp( 0.25, 1.5, run * move ) + Math.max( 0, armSwing ) * 0.5;
		P[ s + '_forearm' ] = limb( armSwing + elbow, 0.08, side );
		P[ s + '_hand' ].set( - 0.1, 0, side * - 0.15 );

	}

	P.hips.set( run * 0.14, Math.sin( ph ) * 0.12 * move, 0 );
	P.spine.set( run * 0.1 + breathe, - Math.sin( ph ) * 0.06 * move, 0 );
	P.chest.set( breathe * 2, - Math.sin( ph ) * 0.08 * move, 0 );
	P.neck.set( - run * 0.12, 0, 0 );
	P.head.set( - run * 0.08, Math.sin( t * 0.37 ) * 0.15 * ( 1 - move ), 0 );

	return P;

}

// 걸음 위상: 걸을 땐 보폭 1.25m, 달릴 땐 늘어난다
export function advancePhase( phase, speed, dt ) {

	const stride = speed > 2.5 ? THREE.MathUtils.lerp( 2.2, 3.2, THREE.MathUtils.clamp( ( speed - 4 ) / 4, 0, 1 ) ) : 1.25;
	phase += dt * ( speed / stride ) * Math.PI;
	if ( speed < 0.05 ) phase = THREE.MathUtils.lerp( phase, Math.round( phase / Math.PI ) * Math.PI, Math.min( 1, dt * 4 ) );
	return phase;

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
