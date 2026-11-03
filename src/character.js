import * as THREE from 'three/webgpu';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// three.js 저장소의 r187 태그로 고정한 CDN (threejs.org 는 릴리스마다 파일이 바뀔 수 있다)
export const ASSETS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r187/examples/';

// webgl_loader_obj 의 male02 를 원본 좌표(cm, +z 가 정면)에서 보고 잡은 관절 위치
const J = {
	hips: [ 2, 95, 2 ], spine: [ 2, 110, 2 ], chest: [ 2, 128, 1 ], neck: [ 2, 151, 0 ], head: [ 2, 160, 1 ], headEnd: [ 2, 183, 1 ],
	L_shoulder: [ 8, 147, 0 ], L_upperArm: [ 19, 145, - 1 ], L_forearm: [ 27, 118, - 2 ], L_hand: [ 26, 100, 5 ], L_handEnd: [ 25, 85, 13 ],
	R_shoulder: [ - 4, 147, 0 ], R_upperArm: [ - 16, 145, - 2 ], R_forearm: [ - 21, 122, - 19 ], R_hand: [ - 20, 108, - 3 ], R_handEnd: [ - 19, 99, 11 ],
	L_thigh: [ 12, 92, 2 ], L_shin: [ 19.5, 50, - 2.5 ], L_foot: [ 26.5, 9, - 6 ], L_toe: [ 35, 2, 10 ],
	R_thigh: [ - 8.5, 92, 2.5 ], R_shin: [ - 16.7, 50, - 0.5 ], R_foot: [ - 24.5, 9, - 4 ], R_toe: [ - 34, 2, 11 ],
	anus: [ 2, 86, - 9 ]
};

// 발 사이 바닥이 모델 원점
const ORIGIN = [ 2, 0.4, 2 ];
const toModel = ( p ) => new THREE.Vector3( ( p[ 0 ] - ORIGIN[ 0 ] ) * 0.01, ( p[ 1 ] - ORIGIN[ 1 ] ) * 0.01, ( p[ 2 ] - ORIGIN[ 2 ] ) * 0.01 );

// 이름, 부모, 시작 관절, 끝 관절, 살 두께(cm), 부모와 섞이는 폭(cm)
const BONES = [
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

// 얼굴: 첨부한 이미지처럼 주황 바탕에 검은 네모 눈 두 개
export const FACE_ORANGE = '#ff6726';

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

// ---------------------------------------------------------------------------
// 포즈 도우미: 원하는 방향을 주면 뼈를 그쪽으로 돌린다

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

// 아래(0,-1,0)에서 앞(+z)으로 pitch, 바깥(side 쪽 x)으로 out 만큼 벌린 방향
export function limb( pitch, out, side, target = new THREE.Vector3() ) {

	const c = Math.cos( pitch );
	return target.set( side * Math.sin( out ) * c, - Math.cos( out ) * c, Math.sin( pitch ) ).normalize();

}

const lerpV = ( a, b, t ) => a.clone().lerp( b, t ).normalize();

// ---------------------------------------------------------------------------

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

		this.nozzle = new THREE.Object3D();
		this.jetDirection = new THREE.Vector3( 0, - 0.8, - 0.6 );
		this.jetOrigin = new THREE.Vector3();

	}

	async load() {

		const loader = new OBJLoader();
		const object = await loader.loadAsync( ASSETS + 'models/obj/male02/male02.obj' );

		const texture = await new THREE.TextureLoader().loadAsync( ASSETS + 'textures/uv_grid_opengl.jpg' );
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 8;

		// 머리(얼굴, 머리카락)는 빼고 몸통, 손, 발만 쓴다. 머리 자리는 네모 얼굴이 들어간다
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

		// 뼈대
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

		const material = new THREE.MeshStandardMaterial( { map: texture, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide } );

		const mesh = new THREE.SkinnedMesh( geometry, material );
		mesh.name = 'MeBody';
		mesh.frustumCulled = false;
		mesh.add( this.bones.hips );
		mesh.bind( new THREE.Skeleton( bones ) );
		this.mesh = mesh;
		this.group.add( mesh );

		// 네모 얼굴 머리
		this.face = createFace();
		// 그늘에서도 이미지 속 주황색이 살도록 살짝 스스로 빛나게
		const orange = new THREE.MeshStandardMaterial( { color: FACE_ORANGE, roughness: 0.65, emissive: FACE_ORANGE, emissiveIntensity: 2.2 } );
		const front = new THREE.MeshStandardMaterial( { map: this.face.texture, roughness: 0.65, emissive: 0xffffff, emissiveMap: this.face.texture, emissiveIntensity: 2.2 } );
		this.headMaterials = [ orange, front ];
		const size = 0.3;
		const head = new THREE.Mesh( new THREE.BoxGeometry( size, size, size ), [ orange, orange, orange, orange, front, orange ] );
		head.position.set( 0, size / 2 - 0.035, 0.012 );
		head.name = 'FaceHead';
		this.bones.head.add( head );
		this.head = head;

		// 엉덩이 분사구
		this.nozzle.position.copy( toModel( J.anus ) ).sub( this.bind.hips.head );
		this.bones.hips.add( this.nozzle );

		// 발밑 그림자
		const canvas = document.createElement( 'canvas' );
		canvas.width = canvas.height = 64;
		const ctx = canvas.getContext( '2d' );
		const gradient = ctx.createRadialGradient( 32, 32, 0, 32, 32, 32 );
		gradient.addColorStop( 0, 'rgba(0,0,0,0.55)' );
		gradient.addColorStop( 1, 'rgba(0,0,0,0)' );
		ctx.fillStyle = gradient;
		ctx.fillRect( 0, 0, 64, 64 );
		const shadowTexture = new THREE.CanvasTexture( canvas );
		this.shadow = new THREE.Mesh(
			new THREE.PlaneGeometry( 1, 1 ).rotateX( - Math.PI / 2 ),
			new THREE.MeshBasicMaterial( { map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false } )
		);
		this.shadow.renderOrder = 1;

		this.restAnkle = {
			L: this.bind.L_foot.head.y,
			R: this.bind.R_foot.head.y
		};
		this.restToe = {
			L: toModel( J.L_toe ).y,
			R: toModel( J.R_toe ).y
		};
		this.hipsRest = this.bind.hips.head.clone();
		this.groundOffset = 0;

		return this;

	}

	// ------------------------------------------------------------------
	// 포즈 계산

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
			aim( s + '_upperArm', pose[ s + '_upperArm' ].clone().applyQuaternion( chest ) );
			aim( s + '_forearm', pose[ s + '_forearm' ].clone().applyQuaternion( chest ) );
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

	// ------------------------------------------------------------------

	buildPose( dt, f ) {

		const t = this.time;
		const P = {
			hipsOffset: new THREE.Vector3(),
			hips: new THREE.Euler(),
			spine: new THREE.Euler(), chest: new THREE.Euler(), neck: new THREE.Euler(), head: new THREE.Euler(),
			L_shoulder: new THREE.Euler(), R_shoulder: new THREE.Euler(),
			L_hand: new THREE.Euler(), R_hand: new THREE.Euler(),
			legFrame: new THREE.Quaternion()
		};

		// 기본 서기 + 걷기/달리기
		const run = THREE.MathUtils.clamp( ( this.speed - 2 ) / 2.5, 0, 1 );
		const move = THREE.MathUtils.clamp( this.speed / 1.4, 0, 1 );
		const ph = this.phase;
		const breathe = Math.sin( t * 1.6 ) * 0.012;

		const swingAmp = THREE.MathUtils.lerp( 0.42, 0.75, run ) * move;
		const kneeAmp = THREE.MathUtils.lerp( 0.75, 1.35, run ) * move;

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
			const armSwing = - Math.sin( p ) * THREE.MathUtils.lerp( 0.45, 0.9, run ) * move;
			P[ s + '_upperArm' ] = limb( armSwing + 0.05, 0.13 + breathe, side );
			const elbow = THREE.MathUtils.lerp( 0.25, 1.45, run * move ) + Math.max( 0, armSwing ) * 0.5;
			P[ s + '_forearm' ] = limb( armSwing + elbow, 0.08, side );
			P[ s + '_hand' ].set( - 0.1, 0, side * - 0.15 );

		}

		P.hips.set( run * 0.12, Math.sin( ph ) * 0.12 * move, 0 );
		P.spine.set( run * 0.08 + breathe, - Math.sin( ph ) * 0.06 * move, 0 );
		P.chest.set( breathe * 2, - Math.sin( ph ) * 0.08 * move, 0 );
		P.neck.set( - run * 0.12, 0, 0 );
		P.head.set( - run * 0.08, Math.sin( t * 0.37 ) * 0.15 * ( 1 - move ), 0 );

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

			P.hipsOffset.y = THREE.MathUtils.lerp( P.hipsOffset.y, - 0.82, down );
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
			const target = farting ? 0 : ( input.run ? 4.6 : 1.7 );
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

				if ( up > mass * g ) {

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
		const stride = this.speed > 2.5 ? 2.2 : 1.25;
		this.phase += dt * ( this.speed / stride ) * Math.PI * 2 * 0.5;
		if ( this.speed < 0.05 ) this.phase = THREE.MathUtils.lerp( this.phase, Math.round( this.phase / Math.PI ) * Math.PI, dt * 4 );

		const k = Math.min( 1, dt * 7 );
		this.fartBlend = THREE.MathUtils.lerp( this.fartBlend, farting && this.state === 'ground' ? 1 : 0, Math.min( 1, dt * 10 ) );
		this.flyBlend = THREE.MathUtils.lerp( this.flyBlend, this.state === 'air' ? 1 : 0, k );
		this.downBlend = THREE.MathUtils.lerp( this.downBlend, this.state === 'down' ? 1 : 0, Math.min( 1, dt * ( this.state === 'down' ? 9 : 3 ) ) );
		if ( this.wasFarting && ! farting ) this.relief = 0.01;
		if ( this.relief > 0 ) this.relief += dt * 0.9;
		if ( this.relief > 1 || farting ) this.relief = 0;
		this.wasFarting = farting;

		const pose = this.buildPose( dt, fart );
		this.group.rotation.y = this.yaw;
		const r = this.solve( pose );

		// 땅에 발 붙이기 (지상에서만)
		const grounded = this.state === 'ground' ? 1 - this.flyBlend : 0;
		const lowest = Math.min( r.footL, r.footR );
		this.groundOffset = THREE.MathUtils.lerp( this.groundOffset, - lowest * grounded, Math.min( 1, dt * 18 ) );
		if ( this.state !== 'ground' ) this.groundOffset *= Math.max( 0, 1 - dt * 6 );
		this.bones.hips.position.y += this.groundOffset;

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
		const hipsWorld = this.bones.hips.getWorldQuaternion( new THREE.Quaternion() );
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
