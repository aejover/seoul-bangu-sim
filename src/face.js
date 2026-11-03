import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { ASSETS } from './rig.js';

// webgl_decals 의 Lee Perry-Smith 머리 스캔으로 행인 얼굴을 만든다.
// 스캔은 눈을 감고 있으므로 감은 눈꺼풀 위에 뜬 눈을 데칼로 붙이고 (깜빡이면 데칼을 접는다),
// 입술은 붙어 있는 이음매를 갈라 턱을 벌릴 수 있게 한 뒤, 표정은 모프 타깃으로 만든다.

const BASE = ASSETS + 'models/gltf/LeePerrySmith/';

// 스캔 좌표 (정면 +z, 1 단위 ≈ 4.9 cm) 에서 재어 둔 얼굴 위치
const F = {
	cx: - 0.09,
	eyeY: 1.68, eyeR: - 0.73, eyeL: 0.53, eyeZ: 1.96,
	mouthY: 0.442, mouthHalf: 0.42,
	browY: 2.02,
	neckCut: - 1.6
};

export const HEAD_SCALE = 0.049;
export const MORPHS = [ 'jawOpen', 'smile', 'sad', 'frown', 'browUp', 'sneer' ];
const JAW_PIVOT = new THREE.Vector3( F.cx, 0.9, - 0.3 );
export const JAW_ANGLE = 0.3;

// e0 > e1 이면 내려가는 계단 (THREE.MathUtils.smoothstep 은 거꾸로 된 경계를 못 쓴다)
const smooth = ( x, e0, e1 ) => {

	const t = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return t * t * ( 3 - 2 * t );

};
const gauss = ( dx, dy, dz, sx, sy = sx, sz = sx ) => Math.exp( - ( dx * dx / ( sx * sx ) + dy * dy / ( sy * sy ) + dz * dz / ( sz * sz ) ) );

// ---------------------------------------------------------------------------
// 머리 메시 가공

function cropAndSplit( source ) {

	const pos = source.attributes.position;
	const nor = source.attributes.normal;
	const uv = source.attributes.uv;
	const index = source.index.array;

	// 목 아래(어깨) 삼각형은 버린다
	const tris = [];

	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ], b = index[ t + 1 ], c = index[ t + 2 ];
		const cy = ( pos.getY( a ) + pos.getY( b ) + pos.getY( c ) ) / 3;
		if ( cy > F.neckCut ) tris.push( a, b, c );

	}

	// 입술 이음매: 입 안쪽에서 윗입술과 아랫입술을 잇는 삼각형을 위/아래로 나누고,
	// 양쪽이 같이 쓰는 정점을 아래쪽용으로 하나 더 만든다
	const inMouth = ( i ) => Math.abs( pos.getX( i ) - F.cx ) < F.mouthHalf && pos.getY( i ) > F.mouthY - 0.14 && pos.getY( i ) < F.mouthY + 0.14 && pos.getZ( i ) > 1.95;
	const usedUpper = new Set(), usedLower = new Set();
	const side = [];

	for ( let t = 0; t < tris.length; t += 3 ) {

		const v = [ tris[ t ], tris[ t + 1 ], tris[ t + 2 ] ];
		if ( ! v.every( inMouth ) ) {

			side.push( 0 );
			continue;

		}

		const cy = ( pos.getY( v[ 0 ] ) + pos.getY( v[ 1 ] ) + pos.getY( v[ 2 ] ) ) / 3;
		const lower = cy < F.mouthY;
		side.push( lower ? - 1 : 1 );
		for ( const i of v ) ( lower ? usedLower : usedUpper ).add( i );

	}

	const shared = [ ...usedLower ].filter( ( i ) => usedUpper.has( i ) );
	const remap = new Map();
	const count = pos.count;
	const extra = shared.length;

	const P = new Float32Array( ( count + extra ) * 3 );
	const N = new Float32Array( ( count + extra ) * 3 );
	const U = new Float32Array( ( count + extra ) * 2 );
	P.set( pos.array );
	N.set( nor.array );
	U.set( uv.array );

	shared.forEach( ( i, k ) => {

		const j = count + k;
		remap.set( i, j );
		for ( let c = 0; c < 3; c ++ ) {

			P[ j * 3 + c ] = pos.array[ i * 3 + c ];
			N[ j * 3 + c ] = nor.array[ i * 3 + c ];

		}

		U[ j * 2 ] = uv.array[ i * 2 ];
		U[ j * 2 + 1 ] = uv.array[ i * 2 + 1 ];

	} );

	for ( let t = 0, k = 0; t < tris.length; t += 3, k ++ ) {

		if ( side[ k ] !== - 1 ) continue;
		for ( let c = 0; c < 3; c ++ ) {

			const j = remap.get( tris[ t + c ] );
			if ( j !== undefined ) tris[ t + c ] = j;

		}

	}

	const lowerLip = new Uint8Array( count + extra );
	for ( let k = count; k < count + extra; k ++ ) lowerLip[ k ] = 1;
	for ( const i of usedLower ) if ( ! usedUpper.has( i ) ) lowerLip[ i ] = 1;
	const upperLip = new Uint8Array( count + extra );
	for ( const i of usedUpper ) upperLip[ i ] = 1;

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( P, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( N, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( U, 2 ) );
	geometry.setIndex( tris );

	return { geometry, lowerLip, upperLip };

}

// 여자 얼굴: 턱과 목을 좁히고, 턱끝·눈썹뼈를 낮추고, 코는 작게, 입술은 도톰하게
function feminize( geometry ) {

	const p = geometry.attributes.position;
	const v = new THREE.Vector3();

	for ( let i = 0; i < p.count; i ++ ) {

		v.fromBufferAttribute( p, i );
		const dx = v.x - F.cx;

		// 턱선과 목
		const narrow = 0.16 * smooth( v.y, 1.0, - 0.5 ) * smooth( v.z, - 1.5, - 0.3 );
		v.x = F.cx + dx * ( 1 - narrow );

		// 턱끝
		v.z -= 0.08 * gauss( dx, v.y + 0.5, v.z - 2.0, 0.5, 0.4, 0.8 );
		v.y += 0.05 * gauss( dx, v.y + 0.5, v.z - 2.0, 0.5, 0.4, 0.8 );

		// 눈썹뼈
		v.z -= 0.06 * gauss( Math.abs( dx ) - 0.6, v.y - 2.15, v.z - 2.0, 0.45, 0.22, 0.6 );

		// 코
		const nose = gauss( dx, v.y - 1.1, v.z - 2.3, 0.35, 0.5, 0.5 );
		v.x = F.cx + ( v.x - F.cx ) * ( 1 - 0.14 * nose );
		v.z -= 0.1 * nose;

		// 입술
		const lip = gauss( dx, v.y - F.mouthY, v.z - 2.25, 0.42, 0.16, 0.25 );
		v.z += 0.05 * lip;
		v.y = F.mouthY + ( v.y - F.mouthY ) * ( 1 + 0.12 * lip );

		p.setXYZ( i, v.x, v.y, v.z );

	}

	geometry.computeVertexNormals();

}

// 표정 모프 타깃 (상대 변위)
function buildMorphs( geometry, lowerLip, upperLip ) {

	const p = geometry.attributes.position;
	const n = p.count;
	const targets = MORPHS.map( () => new Float32Array( n * 3 ) );
	const v = new THREE.Vector3();
	const r = new THREE.Vector3();
	const rot = new THREE.Matrix4().makeRotationX( JAW_ANGLE );

	for ( let i = 0; i < n; i ++ ) {

		v.fromBufferAttribute( p, i );
		const dx = v.x - F.cx, adx = Math.abs( dx ), sx = Math.sign( dx ) || 1;
		const set = ( k, x, y, z ) => {

			targets[ k ][ i * 3 ] += x;
			targets[ k ][ i * 3 + 1 ] += y;
			targets[ k ][ i * 3 + 2 ] += z;

		};

		// jawOpen: 아래턱을 귀 앞 경첩으로 돌린다
		// 입술은 가운데가 가장 많이 벌어지고 입꼬리로 갈수록 붙어 있다 (렌즈 모양)
		let jaw = 0;
		const lens = Math.max( 0, 1 - Math.pow( adx / ( F.mouthHalf + 0.04 ), 2 ) );
		const chin = smooth( v.y, F.mouthY - 0.08, F.mouthY - 0.5 );

		if ( lowerLip[ i ] ) jaw = lens + ( 1 - lens ) * chin;
		else if ( ! upperLip[ i ] ) {

			const below = adx < F.mouthHalf ? ( v.y < F.mouthY ? 1 : 0 ) : smooth( v.y, F.mouthY + 0.05, F.mouthY - 0.3 );
			jaw = below * ( lens + ( 1 - lens ) * chin ) * smooth( v.y, - 1.55, - 0.85 ) * smooth( v.z, - 0.4, 0.7 ) * smooth( adx, 1.75, 1.15 );

		}

		if ( jaw > 0 ) {

			r.copy( v ).sub( JAW_PIVOT ).applyMatrix4( rot ).add( JAW_PIVOT ).sub( v ).multiplyScalar( jaw );
			set( 0, r.x, r.y, r.z );

		}

		// smile: 입꼬리를 위·바깥·뒤로, 볼을 위로
		const corner = gauss( adx - F.mouthHalf, v.y - F.mouthY, v.z - 2.1, 0.26, 0.22, 0.5 );
		const cheek = gauss( adx - 0.78, v.y - 0.95, v.z - 1.9, 0.36, 0.32, 0.6 );
		set( 1, sx * 0.1 * corner, 0.2 * corner + 0.1 * cheek, - 0.06 * corner + 0.06 * cheek );

		// sad: 입꼬리 아래로, 눈썹 안쪽 위로
		const browIn = gauss( adx - 0.32, v.y - F.browY, v.z - 2.0, 0.25, 0.2, 0.6 ) * smooth( v.y, 1.8, 1.92 );
		set( 2, 0, - 0.08 * corner + 0.08 * browIn, - 0.02 * corner );

		// frown: 미간을 모으고 눈썹을 내린다
		set( 3, - sx * 0.06 * browIn, - 0.11 * browIn, 0.03 * browIn );

		// browUp: 눈썹과 이마를 올린다
		const brow = gauss( adx - 0.62, v.y - F.browY - 0.1, v.z - 1.9, 0.5, 0.3, 0.8 ) * smooth( v.y, 1.84, 1.98 );
		set( 4, 0, 0.13 * brow, 0.01 * brow );

		// sneer: 윗입술과 콧방울을 들어 올린다 (냄새!)
		const lip = gauss( adx - 0.18, v.y - 0.62, v.z - 2.25, 0.22, 0.14, 0.4 ) * ( lowerLip[ i ] ? 0 : 1 );
		const wing = gauss( adx - 0.33, v.y - 1.02, v.z - 2.0, 0.16, 0.16, 0.4 );
		set( 5, 0, 0.07 * lip + 0.06 * wing, 0.02 * lip + 0.02 * wing );

	}

	geometry.morphAttributes.position = targets.map( ( a ) => new THREE.BufferAttribute( a, 3 ) );
	geometry.morphTargetsRelative = true;

}

// ---------------------------------------------------------------------------
// 머리카락: 머리 표면 중 머리카락 자리를 바깥으로 부풀린 껍데기 + 긴 머리는 뒤로 늘어뜨린 커튼

// 머리 중심에서 본 방향으로 머리카락 자리를 정한다: 앞(이마)은 높고, 귀 위는 낮고, 뒤(목덜미)는 아주 낮다
const HAIR_CENTER = new THREE.Vector3( F.cx, 1.55, - 0.2 );

function hairAmount( x, y, z, female ) {

	const dx = x - HAIR_CENTER.x, dy = y - HAIR_CENTER.y, dz = z - HAIR_CENTER.z;
	const len = Math.hypot( dx, dy, dz ) || 1;
	const up = dy / len;
	const t = Math.abs( Math.atan2( dx, dz ) ) / Math.PI; // 0 = 정면, 1 = 뒤
	const table = [ [ 0, female ? 0.5 : 0.56 ], [ 0.17, female ? 0.42 : 0.47 ], [ 0.32, 0.3 ], [ 0.5, 0.16 ], [ 0.7, - 0.1 ], [ 1, - 0.5 ] ];
	let line = table[ table.length - 1 ][ 1 ];

	for ( let k = 1; k < table.length; k ++ ) {

		if ( t <= table[ k ][ 0 ] ) {

			const [ t0, a0 ] = table[ k - 1 ], [ t1, a1 ] = table[ k ];
			line = a0 + ( a1 - a0 ) * ( t - t0 ) / ( t1 - t0 );
			break;

		}

	}

	// 0 = 머리카락 없음, 1 = 완전히 덮임 (경계에서 부드럽게)
	return smooth( up, line - 0.03, line + 0.1 );

}

// 머리카락 결 텍스처 (세로 줄무늬)
let strandTexture = null;

function strands() {

	if ( strandTexture ) return strandTexture;
	const canvas = document.createElement( 'canvas' );
	canvas.width = 256;
	canvas.height = 64;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#b8b8b8';
	ctx.fillRect( 0, 0, 256, 64 );

	for ( let i = 0; i < 520; i ++ ) {

		const x = Math.random() * 256;
		const v = 120 + Math.random() * 135;
		ctx.strokeStyle = `rgba(${ v },${ v },${ v },0.55)`;
		ctx.lineWidth = 0.6 + Math.random() * 1.4;
		ctx.beginPath();
		ctx.moveTo( x, 0 );
		ctx.lineTo( x + ( Math.random() - 0.5 ) * 6, 64 );
		ctx.stroke();

	}

	strandTexture = new THREE.CanvasTexture( canvas );
	strandTexture.wrapS = strandTexture.wrapT = THREE.RepeatWrapping;
	strandTexture.colorSpace = THREE.SRGBColorSpace;
	return strandTexture;

}

// 결이 위에서 아래로 흐르도록 머리 둘레 각도를 u, 높이를 v 로
function hairUV( geometry ) {

	const p = geometry.attributes.position;
	const uv = new Float32Array( p.count * 2 );

	for ( let i = 0; i < p.count; i ++ ) {

		uv[ i * 2 ] = ( Math.atan2( p.getX( i ) - F.cx, p.getZ( i ) + 0.2 ) / Math.PI + 1 ) * 3;
		uv[ i * 2 + 1 ] = p.getY( i ) * 0.25;

	}

	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );

}

function hairCap( geometry, female, volume ) {

	const p = geometry.attributes.position;
	const nrm = geometry.attributes.normal;
	const index = geometry.index.array;
	const amount = new Float32Array( p.count );

	for ( let i = 0; i < p.count; i ++ ) amount[ i ] = hairAmount( p.getX( i ), p.getY( i ), p.getZ( i ), female );

	const map = new Map();
	const positions = [];
	const tris = [];

	const vertex = ( i ) => {

		let j = map.get( i );
		if ( j !== undefined ) return j;
		const y = p.getY( i );
		// 정수리 쪽이 더 두툼하고, 머리선에서는 두께 0 으로 피부에 붙는다
		const t = ( 0.05 + volume * smooth( y, 1.2, 3.7 ) ) * amount[ i ] - 0.01;
		positions.push( p.getX( i ) + nrm.getX( i ) * t, y + nrm.getY( i ) * t, p.getZ( i ) + nrm.getZ( i ) * t );
		j = positions.length / 3 - 1;
		map.set( i, j );
		return j;

	};

	for ( let t = 0; t < index.length; t += 3 ) {

		const a = index[ t ], b = index[ t + 1 ], c = index[ t + 2 ];
		if ( amount[ a ] + amount[ b ] + amount[ c ] > 0.15 ) tris.push( vertex( a ), vertex( b ), vertex( c ) );

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	g.setIndex( tris );
	g.computeVertexNormals();
	hairUV( g );
	return g;

}

// 뒤로 늘어뜨린 머리 (bottom: 끝 높이)
function hairCurtain( geometry, bottom ) {

	// 귀 높이에서 머리 둘레를 잰다
	const p = geometry.attributes.position;
	const bins = 48;
	const radius = new Float32Array( bins );

	for ( let i = 0; i < p.count; i ++ ) {

		const y = p.getY( i );
		if ( y < 1.2 || y > 2.6 ) continue;
		const x = p.getX( i ) - F.cx, z = p.getZ( i ) + 0.15;
		const a = Math.atan2( x, - z ); // 0 = 뒤통수
		const b = Math.floor( ( a / Math.PI * 0.5 + 0.5 ) * bins ) % bins;
		radius[ b ] = Math.max( radius[ b ], Math.hypot( x, z ) );

	}

	const span = Math.PI * 0.6;
	const cols = 32, rows = 14;
	const positions = [];
	const top = 2.7;

	for ( let r = 0; r <= rows; r ++ ) {

		const v = r / rows;

		for ( let c = 0; c <= cols; c ++ ) {

			const u = c / cols;
			const a = - span + 2 * span * u;
			const b = Math.floor( ( a / Math.PI * 0.5 + 0.5 ) * bins ) % bins;
			// 끝단은 살짝 들쭉날쭉, 앞쪽 옆머리는 조금 짧게
			const edge = Math.abs( u - 0.5 ) * 2;
			const hem = bottom + 0.35 * edge * edge + Math.sin( c * 2.3 ) * 0.08;
			const y = top + ( hem - top ) * v;
			const rr = Math.max( radius[ b ], 1.6 ) + 0.1 + 0.3 * v * v;
			const wave = Math.sin( c * 1.7 + r * 0.9 ) * 0.025;
			positions.push( F.cx + Math.sin( a ) * ( rr + wave ), y, - 0.15 - Math.cos( a ) * ( rr + wave ) );

		}

	}

	const tris = [];

	for ( let r = 0; r < rows; r ++ ) {

		for ( let c = 0; c < cols; c ++ ) {

			const i = r * ( cols + 1 ) + c;
			tris.push( i, i + cols + 1, i + 1, i + 1, i + cols + 1, i + cols + 2 );

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	g.setIndex( tris );
	g.computeVertexNormals();
	hairUV( g );
	return g;

}

// ---------------------------------------------------------------------------
// 여자 피부 텍스처: 정점의 UV 자리에 붓질해서 수염 자국을 지우고, 입술·볼에 색을 얹는다

function makeupTexture( image, geometry ) {

	const W = image.width, H = image.height;
	const canvas = document.createElement( 'canvas' );
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext( '2d' );
	ctx.drawImage( image, 0, 0 );

	const p = geometry.attributes.position;
	const uv = geometry.attributes.uv;
	const at = ( i ) => [ uv.getX( i ) * W, ( 1 - uv.getY( i ) ) * H ];

	// 볼에서 맨 피부색을 뽑는다
	let skin = [ 0, 0, 0 ], n = 0;

	for ( let i = 0; i < p.count; i += 7 ) {

		const dx = Math.abs( p.getX( i ) - F.cx );
		if ( dx > 0.7 && dx < 1.0 && p.getY( i ) > 1.0 && p.getY( i ) < 1.3 && p.getZ( i ) > 1.6 ) {

			const [ x, y ] = at( i );
			const d = ctx.getImageData( x | 0, y | 0, 1, 1 ).data;
			skin = [ skin[ 0 ] + d[ 0 ], skin[ 1 ] + d[ 1 ], skin[ 2 ] + d[ 2 ] ];
			n ++;

		}

	}

	skin = skin.map( ( c ) => Math.round( c / Math.max( 1, n ) ) );
	const r = Math.max( 2, W / 300 );

	const dab = ( i, color, alpha, scale = 1 ) => {

		if ( alpha < 0.004 ) return;
		const [ x, y ] = at( i );
		ctx.fillStyle = `rgba(${ color },${ alpha })`;
		ctx.beginPath();
		ctx.arc( x, y, r * scale, 0, Math.PI * 2 );
		ctx.fill();

	};

	for ( let i = 0; i < p.count; i ++ ) {

		const x = p.getX( i ), y = p.getY( i ), z = p.getZ( i );
		if ( z < 0.6 ) continue;
		const dx = x - F.cx, adx = Math.abs( dx );
		const lips = gauss( dx, y - F.mouthY, 0, 0.4, 0.14, 1 ) * smooth( z, 1.85, 2.05 );

		// 수염 자국 (턱, 인중, 턱선)
		const beard = smooth( y, - 1.0, - 0.4 ) * smooth( y, 1.0, 0.75 ) * smooth( adx, 1.45, 1.05 ) * ( 1 - lips );
		dab( i, skin.join( ',' ), beard * 0.22, 1.6 );

		// 눈썹 아랫부분을 지워 가늘게
		dab( i, skin.join( ',' ), gauss( adx - 0.62, y - 1.9, 0, 0.5, 0.06 ) * 0.25, 1.2 );

		// 볼터치, 아이섀도, 입술
		dab( i, '235,120,120', gauss( adx - 0.85, y - 1.0, 0, 0.32, 0.25 ) * 0.05, 2 );
		dab( i, '150,90,110', gauss( adx - 0.62, y - 1.86, 0, 0.32, 0.1 ) * 0.07, 1.4 );
		dab( i, '205,45,75', lips * 0.16, 1.2 );

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;

}

// ---------------------------------------------------------------------------
// 뜬 눈 텍스처

function eyeTexture( female ) {

	const w = 256, h = 152;
	const canvas = document.createElement( 'canvas' );
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext( '2d' );

	const almond = () => {

		ctx.beginPath();
		ctx.moveTo( 18, 82 );
		ctx.bezierCurveTo( 70, 18, 186, 14, 240, 74 );
		ctx.bezierCurveTo( 190, 128, 74, 134, 18, 82 );
		ctx.closePath();

	};

	// 흰자
	almond();
	const white = ctx.createRadialGradient( 128, 78, 10, 128, 78, 120 );
	white.addColorStop( 0, '#fbf8f4' );
	white.addColorStop( 0.75, '#e9ddd6' );
	white.addColorStop( 1, '#c99c92' );
	ctx.fillStyle = white;
	ctx.fill();

	// 홍채와 동공
	ctx.save();
	almond();
	ctx.clip();
	const iris = ctx.createRadialGradient( 128, 76, 6, 128, 76, 38 );
	iris.addColorStop( 0, '#3b2414' );
	iris.addColorStop( 0.55, '#5a3a22' );
	iris.addColorStop( 0.9, '#2a180c' );
	iris.addColorStop( 1, '#120a05' );
	ctx.fillStyle = iris;
	ctx.beginPath();
	ctx.arc( 128, 76, 38, 0, Math.PI * 2 );
	ctx.fill();
	ctx.fillStyle = '#050302';
	ctx.beginPath();
	ctx.arc( 128, 76, 15, 0, Math.PI * 2 );
	ctx.fill();
	ctx.fillStyle = 'rgba(255,255,255,0.9)';
	ctx.beginPath();
	ctx.arc( 141, 63, 7, 0, Math.PI * 2 );
	ctx.fill();

	// 윗눈꺼풀 그림자
	const lid = ctx.createLinearGradient( 0, 20, 0, 70 );
	lid.addColorStop( 0, 'rgba(60,30,20,0.55)' );
	lid.addColorStop( 1, 'rgba(60,30,20,0)' );
	ctx.fillStyle = lid;
	ctx.fillRect( 0, 0, w, 70 );
	ctx.restore();

	// 속눈썹 라인
	ctx.strokeStyle = '#140c08';
	ctx.lineCap = 'round';
	ctx.lineWidth = female ? 11 : 7;
	ctx.beginPath();
	ctx.moveTo( 16, 84 );
	ctx.bezierCurveTo( 70, 18, 186, 14, female ? 252 : 240, female ? 60 : 74 );
	ctx.stroke();
	ctx.lineWidth = 3;
	ctx.strokeStyle = 'rgba(40,22,14,0.7)';
	ctx.beginPath();
	ctx.moveTo( 24, 86 );
	ctx.bezierCurveTo( 74, 128, 190, 124, 236, 78 );
	ctx.stroke();

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;

}

// ---------------------------------------------------------------------------

export const SKIN_TONES = [ 0xffffff, 0xf3dccb, 0xe6c2a6, 0xd9b08e ];
export const HAIR_COLORS = [ 0x0d0b0a, 0x1c1410, 0x2e1f16, 0x4a3324, 0x7a5a3c, 0x8a8478 ];
export const HAIR_STYLES = { male: [ 'short', 'buzz', 'volume', 'short' ], female: [ 'long', 'bob', 'ponytail', 'long' ] };

export class FaceKit {

	async load() {

		const tl = new THREE.TextureLoader();
		const [ gltf, map, normalMap ] = await Promise.all( [
			new GLTFLoader().loadAsync( BASE + 'LeePerrySmith.glb' ),
			tl.loadAsync( BASE + 'Map-COL.jpg' ),
			tl.loadAsync( BASE + 'Infinite-Level_02_Tangent_SmoothUV.jpg' )
		] );

		map.colorSpace = THREE.SRGBColorSpace;
		map.anisotropy = 4;
		const source = gltf.scene.children[ 0 ].geometry;

		// 입을 벌리면 입술 안쪽 면이 보이므로 양면
		this.skin = SKIN_TONES.map( ( tone ) => new THREE.MeshStandardMaterial( { map, normalMap, normalScale: new THREE.Vector2( 0.6, 0.6 ), color: tone, roughness: 0.62, side: THREE.DoubleSide } ) );
		this.hair = HAIR_COLORS.map( ( c ) => new THREE.MeshStandardMaterial( { color: c, map: strands(), roughness: 0.5, side: THREE.DoubleSide } ) );
		this.mouthMaterial = new THREE.MeshStandardMaterial( { color: 0x2a0707, roughness: 0.9 } );
		this.teethMaterial = new THREE.MeshStandardMaterial( { color: 0xf2ede2, roughness: 0.35 } );
		this.mouthGeometry = new THREE.SphereGeometry( 1, 16, 10 );
		this.teethGeometry = new THREE.BoxGeometry( 0.48, 0.09, 0.07 );

		this.sexes = {};

		for ( const sex of [ 'male', 'female' ] ) {

			const female = sex === 'female';
			const { geometry, lowerLip, upperLip } = cropAndSplit( source );
			if ( female ) feminize( geometry );

			// 감은 눈꺼풀 위에 뜬 눈 데칼 (모프 전 모양 기준)
			const probe = new THREE.Mesh( geometry );
			probe.updateMatrixWorld( true );
			const material = new THREE.MeshStandardMaterial( { map: eyeTexture( female ), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 4, polygonOffsetUnits: - 4, roughness: 0.25 } );
			const eyes = [ [ F.eyeR, - 0.18 ], [ F.eyeL, 0.18 ] ].map( ( [ x, yaw ] ) => {

				const center = new THREE.Vector3( x, F.eyeY, F.eyeZ );
				const size = female ? new THREE.Vector3( 0.68, 0.42, 0.9 ) : new THREE.Vector3( 0.62, 0.37, 0.9 );
				const g = new DecalGeometry( probe, center, new THREE.Euler( 0, yaw, 0 ), size );
				g.translate( - center.x, - center.y, - center.z );
				return { geometry: g, center };

			} );

			buildMorphs( geometry, lowerLip, upperLip );
			geometry.computeBoundingSphere();

			const skin = female ?
				SKIN_TONES.map( ( tone, k ) => {

					const m = this.skin[ k ].clone();
					m.map = this.femaleMap ||= makeupTexture( map.image, geometry );
					return m;

				} ) : this.skin;

			const hair = {};
			for ( const style of HAIR_STYLES[ sex ] ) {

				if ( hair[ style ] ) continue;
				const volume = { short: 0.12, buzz: 0.03, volume: 0.26, long: 0.2, bob: 0.18, ponytail: 0.08 }[ style ];
				const parts = [ hairCap( geometry, female, volume ) ];
				if ( style === 'long' ) parts.push( hairCurtain( geometry, - 4.6 ) );
				if ( style === 'bob' ) parts.push( hairCurtain( geometry, - 0.6 ) );
				hair[ style ] = parts;

			}

			this.sexes[ sex ] = { geometry, eyes, eyeMaterial: material, hair, skin };

		}

		// 묶은 머리 꼬리
		this.ponytail = new THREE.CapsuleGeometry( 0.42, 2.4, 4, 10 );
		this.ponytail.translate( 0, - 1.6, 0 );

		return this;

	}

}

// ---------------------------------------------------------------------------
// 행인 한 명의 얼굴

export class Face {

	constructor( kit, sex, { skin = 0, hairColor = 0, hairStyle = null } = {} ) {

		const data = kit.sexes[ sex ];
		this.group = new THREE.Group();

		// 스캔 좌표 → 머리 뼈 좌표 (정수리가 male02 머리 끝 높이에 오도록)
		const s = HEAD_SCALE * ( sex === 'female' ? 0.96 : 1 );
		this.group.scale.setScalar( s );
		this.group.position.set( - F.cx * s, 0.039 - ( sex === 'female' ? 0.006 : 0 ), 0.004 );

		this.head = new THREE.Mesh( data.geometry, data.skin[ skin ] );
		this.head.name = 'PersonHead';
		this.group.add( this.head );

		// 입 속
		const mouth = new THREE.Mesh( kit.mouthGeometry, kit.mouthMaterial );
		mouth.position.set( F.cx, 0.32, 1.62 );
		mouth.scale.set( 0.5, 0.36, 0.34 );
		this.group.add( mouth );
		const upperTeeth = new THREE.Mesh( kit.teethGeometry, kit.teethMaterial );
		upperTeeth.position.set( F.cx, 0.5, 1.98 );
		this.group.add( upperTeeth );
		this.jaw = new THREE.Group();
		this.jaw.position.copy( JAW_PIVOT );
		const lowerTeeth = new THREE.Mesh( kit.teethGeometry, kit.teethMaterial );
		lowerTeeth.position.set( F.cx, 0.36, 1.95 ).sub( JAW_PIVOT );
		this.jaw.add( lowerTeeth );
		this.group.add( this.jaw );

		// 눈
		this.eyes = data.eyes.map( ( e ) => {

			const m = new THREE.Mesh( e.geometry, data.eyeMaterial );
			m.position.copy( e.center );
			m.renderOrder = 3;
			this.group.add( m );
			return m;

		} );

		// 머리카락
		const style = hairStyle || HAIR_STYLES[ sex ][ 0 ];
		for ( const g of data.hair[ style ] ) this.group.add( new THREE.Mesh( g, kit.hair[ hairColor ] ) );

		if ( style === 'ponytail' ) {

			const tail = new THREE.Mesh( kit.ponytail, kit.hair[ hairColor ] );
			tail.position.set( F.cx, 2.4, - 2.55 );
			tail.rotation.x = 0.35;
			this.group.add( tail );
			this.tail = tail;

		}

		this.weights = new Float32Array( MORPHS.length );
		this.blink = Math.random() * 3;
		this.eyeOpen = 1;
		this.time = Math.random() * 100;

	}

	// expr: { jawOpen, smile, sad, frown, browUp, sneer, squint, wide, talk }
	update( dt, expr ) {

		this.time += dt;
		const k = Math.min( 1, dt * 10 );

		for ( let i = 0; i < MORPHS.length; i ++ ) {

			let target = expr[ MORPHS[ i ] ] || 0;
			if ( i === 0 && expr.talk ) target = Math.max( target, ( Math.sin( this.time * 17 ) * 0.5 + 0.5 ) * 0.45 * expr.talk );
			this.weights[ i ] += ( target - this.weights[ i ] ) * k;
			this.head.morphTargetInfluences[ i ] = this.weights[ i ];

		}

		this.jaw.rotation.x = JAW_ANGLE * this.weights[ 0 ];

		// 깜빡임 (데칼을 접으면 원래 감은 눈꺼풀이 보인다)
		this.blink -= dt;
		let open = 1;
		if ( this.blink < 0.14 ) open = Math.abs( this.blink - 0.07 ) / 0.07;
		if ( this.blink < 0 ) this.blink = 1.5 + Math.random() * 4;
		const shape = 1 - 0.45 * ( expr.squint || 0 ) + 0.15 * ( expr.wide || 0 );
		this.eyeOpen += ( shape - this.eyeOpen ) * k;
		const y = this.eyeOpen * open * ( expr.closed ? 0 : 1 );

		for ( const e of this.eyes ) {

			e.visible = this.detail !== false && y > 0.12;
			e.scale.set( 1, Math.max( 0.12, y ), 1 );

		}

		if ( this.tail ) this.tail.rotation.z = Math.sin( this.time * 3 ) * 0.08 * ( expr.bounce || 0.3 );

	}

}
