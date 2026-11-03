import * as THREE from 'three/webgpu';
import {
	abs, attribute, cameraPosition, color, dot, float, floor, Fn, fract, fwidth, hash, If, instanceIndex, max, mix, mod,
	mx_fractal_noise_float, mx_noise_float, normalWorld, positionLocal, positionWorld, select, sin, smoothstep, step,
	texture, time, uniform, varying, vec3, vec4
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bumpNormal } from 'three/addons/generators/city/CityGeneratorUtils.js';

// 낮 0 → 밤 1. 간판, 창문, 남산타워 조명이 이 값을 따른다
export const nightness = uniform( 0 );

function createRandom( seed ) {

	let s = ( seed >>> 0 ) || 1;

	return function () {

		s = ( s + 0x6D2B79F5 ) | 0;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// ---------------------------------------------------------------------------
// 서울 도로: 노란 겹 중앙선, 흰 점선 차선, 정지선, 횡단보도 (우측통행)

function lineAA( coord, halfWidth ) {

	const aa = fwidth( coord ).max( 0.0001 );
	return smoothstep( float( halfWidth ).add( aa ), float( halfWidth ).sub( aa ), coord.abs() );

}

function gridLine( coord, period, halfWidth ) {

	const g = coord.div( period );
	const d = float( 0.5 ).sub( fract( g ).sub( 0.5 ).abs() );
	const aa = fwidth( g ).max( 0.0001 );
	const hw = halfWidth / period;
	return smoothstep( float( hw ).add( aa ), float( hw ).sub( aa ), d );

}

export function createSeoulRoadMaterial( layout ) {

	const p = positionWorld;
	const dist = p.distance( cameraPosition );
	const detail = smoothstep( 260, 25, dist );
	const farPaint = smoothstep( 700, 30, dist );
	const microFade = smoothstep( 22, 4, dist );

	const blotch = mx_fractal_noise_float( p.mul( 0.2 ), 3 ).mul( 0.5 ).add( 0.5 );

	const near = Fn( () => {

		const grit = float( 0 ).toVar();
		const stain = float( 0 ).toVar();
		const worn = float( 1 ).toVar();
		const micro = float( 0 ).toVar();

		If( detail.greaterThan( 0 ), () => {

			grit.assign( mx_noise_float( p.mul( 7 ) ).add( mx_noise_float( p.mul( 23 ) ) ).mul( 0.5 ) );
			stain.assign( smoothstep( 0.5, 0.85, mx_fractal_noise_float( p.mul( 0.45 ), 3 ).mul( 0.5 ).add( 0.5 ) ) );
			worn.assign( smoothstep( 0.25, 0.7, mx_fractal_noise_float( p.mul( 0.7 ), 3 ).mul( 0.5 ).add( 0.5 ) ).mul( 0.4 ).add( 0.55 ) );

		} );

		If( microFade.greaterThan( 0 ), () => {

			micro.assign( mx_noise_float( p.mul( 45 ) ).mul( 0.6 ).add( mx_noise_float( p.mul( 80 ) ).mul( 0.4 ) ) );

		} );

		return vec4( grit, stain, worn, micro );

	} )();

	const grit = near.x, stain = near.y, worn = near.z, micro = near.w;

	// 서울 아스팔트는 조금 더 어둡고 고르다
	const base = mix( color( 0x1e2024 ), color( 0x30333a ), blotch );
	const gritty = base.mul( grit.mul( 0.2 ).mul( detail ).add( 1 ) );
	const asphalt = mix( gritty, gritty.mul( 0.55 ), stain.mul( 0.5 ).mul( detail ) );
	const wet = smoothstep( 0.62, 0.86, mx_fractal_noise_float( p.mul( 0.14 ), 2 ).mul( 0.5 ).add( 0.5 ) );

	const periodX = layout.blockW + layout.street;
	const periodZ = layout.blockD + layout.street;
	const fx = mod( p.x.add( layout.cityW / 2 ), periodX );
	const fz = mod( p.z.add( layout.cityD / 2 ), periodZ );
	const inStreetX = step( layout.blockW, fx );
	const inStreetZ = step( layout.blockD, fz );
	const su = fx.sub( layout.blockW );
	const sv = fz.sub( layout.blockD );
	const half = layout.street / 2;
	const alongV = inStreetX.mul( inStreetZ.oneMinus() ); // 세로(z 방향) 도로 구간
	const alongH = inStreetZ.mul( inStreetX.oneMinus() ); // 가로(x 방향) 도로 구간

	// 중앙선: 노란 겹실선
	const yellowV = lineAA( su.sub( half - 0.2 ), 0.075 ).max( lineAA( su.sub( half + 0.2 ), 0.075 ) ).mul( alongV );
	const yellowH = lineAA( sv.sub( half - 0.2 ), 0.075 ).max( lineAA( sv.sub( half + 0.2 ), 0.075 ) ).mul( alongH );

	// 차선: 3m 칠하고 5m 띄우는 흰 점선
	const dashV = step( fract( p.z.div( 8 ) ), 0.375 );
	const dashH = step( fract( p.x.div( 8 ) ), 0.375 );
	const laneV = lineAA( su.sub( layout.street / 4 ), 0.075 ).max( lineAA( su.sub( layout.street * 3 / 4 ), 0.075 ) ).mul( dashV ).mul( alongV );
	const laneH = lineAA( sv.sub( layout.street / 4 ), 0.075 ).max( lineAA( sv.sub( layout.street * 3 / 4 ), 0.075 ) ).mul( dashH ).mul( alongH );

	// 정지선: 교차로로 들어가는 쪽 차로에만
	const stopV = lineAA( fz.sub( layout.blockD - 5.8 ), 0.22 ).mul( step( su, half - 0.4 ) )
		.max( lineAA( fz.sub( 5.8 ), 0.22 ).mul( step( half + 0.4, su ) ) ).mul( alongV );
	const stopH = lineAA( fx.sub( layout.blockW - 5.8 ), 0.22 ).mul( step( half + 0.4, sv ) )
		.max( lineAA( fx.sub( 5.8 ), 0.22 ).mul( step( sv, half - 0.4 ) ) ).mul( alongH );

	// 횡단보도: 폭 50cm 줄무늬
	const cw = 5;
	const nearZ = step( fz, cw ).max( step( layout.blockD - cw, fz ) );
	const nearX = step( fx, cw ).max( step( layout.blockW - cw, fx ) );
	const crossV = gridLine( su.add( 0.5 ), 1.0, 0.25 ).mul( alongV ).mul( nearZ ).mul( step( 0.6, su ) ).mul( step( su, layout.street - 0.6 ) );
	const crossH = gridLine( sv.add( 0.5 ), 1.0, 0.25 ).mul( alongH ).mul( nearX ).mul( step( 0.6, sv ) ).mul( step( sv, layout.street - 0.6 ) );

	// 중앙선이 지나는 곳엔 횡단보도/점선을 그리지 않는다
	const white = laneV.max( laneH ).max( stopV ).max( stopH ).mul( detail ).max( crossV.max( crossH ).mul( farPaint ) ).mul( worn );
	const yellow = yellowV.max( yellowH ).mul( farPaint ).mul( worn );

	const material = new THREE.MeshStandardNodeMaterial();
	const surface = mix( asphalt, asphalt.mul( 0.6 ), wet );
	const painted = mix( surface, color( 0xd8d6cc ), white );
	material.colorNode = mix( painted, color( 0xf0b000 ), yellow );
	const paint = white.max( yellow );
	material.roughnessNode = mix( float( 0.95 ).sub( paint.mul( 0.2 ) ), float( 0.32 ), wet );
	material.normalNode = bumpNormal( grit.mul( 0.003 ).mul( detail ).add( micro.mul( 0.0016 ).mul( microFade ) ) );

	return material;

}

// ---------------------------------------------------------------------------
// 11월 서울 가로수: 노란 은행나무

export function makeGinkgo( cityGroup ) {

	const done = new Set();

	cityGroup.traverse( ( o ) => {

		if ( o.name !== 'StreetTrees' || ! o.material || done.has( o.material ) ) return;
		done.add( o.material );

		const m = o.material;
		const old = m.colorNode;
		const partId = varying( attribute( 'partId', 'float' ) ).setInterpolation( THREE.InterpolationSamplingType.FLAT, THREE.InterpolationSamplingMode.EITHER );
		const lum = dot( old, vec3( 0.2126, 0.7152, 0.0722 ) );
		const patch = mx_noise_float( positionWorld.mul( 0.35 ) ).mul( 0.5 ).add( 0.5 );
		const turn = fract( sin( float( instanceIndex ).mul( 78.233 ) ).mul( 43758.5453 ) );
		const gold = mix( color( 0xc98f08 ), color( 0xf3cf2c ), patch );
		const leaf = mix( gold, color( 0x9aa62a ), turn.mul( 0.25 ) ).mul( lum.mul( 5.5 ) );
		m.colorNode = select( partId.equal( 1 ), leaf, old );
		m.needsUpdate = true;

	} );

}

// ---------------------------------------------------------------------------
// 한글 간판 아틀라스

const H_TEXTS = [
	'24시 편의점', '치킨 · 호프', '참숯 삼겹살', '얼큰 순대국', '코인노래방', 'PC방', '온누리 약국', '행복 부동산',
	'엄마손 김밥', '즉석 떡볶이', '카페 서울', '콩나물국밥', '곱창 · 막창', '밝은 안경', '헤어 살롱', '크린 세탁소',
	'미소 치과', '한빛 영어학원', '국가대표 태권도', '춘천 닭갈비', '마라탕', '족발 · 보쌈', '포장마차', '노래연습장',
	'당구장', '휴대폰 할인', '서울 정형외과', '고구마 전문점', '방구 클리닉', '24시 해장국', '반찬가게', '수학학원',
	'꽃집', '빵집', '돈까스', '냉면', '한우 정육점', '스크린골프', '필라테스', '다이소 같은 가게',
	'인쇄 · 복사', '열쇠', '통닭', '분식', '찜닭', '중국집', '칼국수', '감자탕'
];

const V_TEXTS = [ '노래방', 'PC방', '호프', '당구장', '치과', '한의원', '학원', '헬스', '사우나', '약국', '병원', '오락실', '만화방', '치킨', '국밥', '카페' ];

const STYLES = [
	{ bg: '#d6201f', fg: '#ffffff' },
	{ bg: '#1f4fbf', fg: '#ffffff' },
	{ bg: '#ffd400', fg: '#c4121a' },
	{ bg: '#0e8a3e', fg: '#ffffff' },
	{ bg: '#111111', fg: '#ff3dbe', neon: true },
	{ bg: '#0b0b10', fg: '#35e7ff', neon: true },
	{ bg: '#ff7a00', fg: '#ffffff' },
	{ bg: '#ffffff', fg: '#1a3d8f' },
	{ bg: '#5b1fa8', fg: '#ffffff' },
	{ bg: '#111111', fg: '#fff200', neon: true },
	{ bg: '#ffffff', fg: '#d6201f' },
	{ bg: '#0a2a6b', fg: '#ffe14d' }
];

const FONT = '"Black Han Sans", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

function drawSignAtlas() {

	const S = 2048;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = S;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#000';
	ctx.fillRect( 0, 0, S, S );

	const cells = { h: [], v: [] };
	const uvRect = ( x, y, w, h ) => ( { u0: ( x + 3 ) / S, u1: ( x + w - 3 ) / S, v0: 1 - ( y + h - 3 ) / S, v1: 1 - ( y + 3 ) / S } );

	// 가로 간판 512×128, 4열 × 12행
	for ( let i = 0; i < 48; i ++ ) {

		const x = ( i % 4 ) * 512, y = Math.floor( i / 4 ) * 128;
		const text = H_TEXTS[ i % H_TEXTS.length ];
		const style = STYLES[ ( i * 5 + 1 ) % STYLES.length ];
		ctx.save();
		ctx.translate( x, y );
		ctx.fillStyle = style.bg;
		ctx.fillRect( 3, 3, 506, 122 );
		ctx.strokeStyle = style.neon ? style.fg : 'rgba(255,255,255,0.55)';
		ctx.lineWidth = 5;
		ctx.strokeRect( 10, 10, 492, 108 );
		let size = 86;
		ctx.font = `${ size }px ${ FONT }`;
		while ( ctx.measureText( text ).width > 460 && size > 30 ) {

			size -= 4;
			ctx.font = `${ size }px ${ FONT }`;

		}

		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		if ( style.neon ) {

			ctx.shadowColor = style.fg;
			ctx.shadowBlur = 16;

		}

		ctx.fillStyle = style.fg;
		ctx.fillText( text, 256, 68 );
		ctx.restore();
		cells.h.push( uvRect( x, y, 512, 128 ) );

	}

	// 세로 간판 128×512, 16열
	for ( let i = 0; i < 16; i ++ ) {

		const x = i * 128, y = 1536;
		const text = V_TEXTS[ i % V_TEXTS.length ];
		const style = STYLES[ ( i * 7 + 2 ) % STYLES.length ];
		ctx.save();
		ctx.translate( x, y );
		ctx.fillStyle = style.bg;
		ctx.fillRect( 3, 3, 122, 506 );
		ctx.strokeStyle = style.neon ? style.fg : 'rgba(255,255,255,0.55)';
		ctx.lineWidth = 5;
		ctx.strokeRect( 10, 10, 108, 492 );
		const chars = [ ...text.replace( / /g, '' ) ];
		const step = 470 / chars.length;
		const size = Math.min( 96, step * 0.9 );
		ctx.font = `${ size }px ${ FONT }`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		if ( style.neon ) {

			ctx.shadowColor = style.fg;
			ctx.shadowBlur = 14;

		}

		ctx.fillStyle = style.fg;
		chars.forEach( ( ch, k ) => ctx.fillText( ch, 64, 22 + step * ( k + 0.5 ) + 4 ) );
		ctx.restore();
		cells.v.push( uvRect( x, y, 128, 512 ) );

	}

	const map = new THREE.CanvasTexture( canvas );
	map.colorSpace = THREE.SRGBColorSpace;
	map.anisotropy = 8;
	return { map, cells };

}

class QuadBuilder {

	constructor() {

		this.position = [];
		this.normal = [];
		this.uv = [];
		this.index = [];

	}

	// center, right, normal: Vector3 / hw, hh: 절반 크기 / cell: 아틀라스 uv
	add( center, right, normal, hw, hh, cell ) {

		const base = this.position.length / 3;
		const up = new THREE.Vector3( 0, 1, 0 );
		const corners = [ [ - 1, - 1, cell.u0, cell.v0 ], [ 1, - 1, cell.u1, cell.v0 ], [ 1, 1, cell.u1, cell.v1 ], [ - 1, 1, cell.u0, cell.v1 ] ];

		for ( const [ sx, sy, u, v ] of corners ) {

			const p = center.clone().addScaledVector( right, sx * hw ).addScaledVector( up, sy * hh );
			this.position.push( p.x, p.y, p.z );
			this.normal.push( normal.x, normal.y, normal.z );
			this.uv.push( u, v );

		}

		this.index.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	}

	build() {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.position, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.normal, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( this.uv, 2 ) );
		g.setIndex( this.index );
		return g;

	}

}

function orientedBox( w, h, d, center, right, normal ) {

	const g = new THREE.BoxGeometry( w, h, d );
	const m = new THREE.Matrix4().makeBasis( right, new THREE.Vector3( 0, 1, 0 ), normal ).setPosition( center );
	return g.applyMatrix4( m );

}

export function buildSigns( world, spawn, radius = 340 ) {

	const random = createRandom( 2026 );
	const { map, cells } = drawSignAtlas();
	const quads = new QuadBuilder();
	const backs = [];
	const crossBars = [];
	const curb = world.curb;
	let forced = false;

	// 빌딩마다 자기 간판이 merge 된 지오메트리의 어느 정점 범위인지 기억한다 (빌딩이 날아가면 지운다)
	const ranges = new Map();
	const BOX_VERTS = 24;

	const signsOf = ( t ) => {

		const dist = Math.hypot( t.cx, t.cz );

		// 교회 첨탑 빨간 십자가 (밤 서울의 상징)
		if ( dist < 900 && random() < 0.07 ) {

			const y = t.top;
			crossBars.push( new THREE.BoxGeometry( 0.22, 2.2, 0.22 ).translate( t.cx, y + 1.1, t.cz ) );
			crossBars.push( new THREE.BoxGeometry( 0.5, 5.2, 0.5 ).translate( t.cx, y + 4.6, t.cz ) );
			crossBars.push( new THREE.BoxGeometry( 3.2, 0.5, 0.5 ).translate( t.cx, y + 5.6, t.cz ) );

		}

		if ( dist > radius ) return;

		const faces = [
			{ n: new THREE.Vector3( 1, 0, 0 ), c: new THREE.Vector3( t.x1, 0, t.cz ), len: t.d },
			{ n: new THREE.Vector3( - 1, 0, 0 ), c: new THREE.Vector3( t.x0, 0, t.cz ), len: t.d },
			{ n: new THREE.Vector3( 0, 0, 1 ), c: new THREE.Vector3( t.cx, 0, t.z1 ), len: t.w },
			{ n: new THREE.Vector3( 0, 0, - 1 ), c: new THREE.Vector3( t.cx, 0, t.z0 ), len: t.w }
		];

		for ( const f of faces ) {

			const probe = f.c.clone().addScaledVector( f.n, 2.5 );
			if ( ! world.isBlock( probe.x, probe.z ) || world.towerAt( probe.x, probe.z ) ) continue; // 인도에 면한 쪽만

			const right = new THREE.Vector3( f.n.z, 0, - f.n.x );
			const count = Math.max( 1, Math.round( f.len / 8 ) );
			const slot = f.len / count;

			// 1층 가게 간판
			for ( let k = 0; k < count; k ++ ) {

				const along = - f.len / 2 + slot * ( k + 0.5 );
				const w = Math.min( 7, slot * 0.86 );
				const h = w / 4;
				const center = f.c.clone().addScaledVector( right, along ).addScaledVector( f.n, 0.3 );
				center.y = curb + 3.25 + h / 2;

				let cell = cells.h[ Math.floor( random() * cells.h.length ) ];
				if ( ! forced && spawn && center.distanceTo( spawn ) < 16 ) {

					cell = cells.h[ 0 ]; // 내 옆 건물은 24시 편의점
					forced = true;

				}

				quads.add( center, right, f.n, w / 2, h / 2, cell );
				backs.push( orientedBox( w + 0.25, h + 0.25, 0.28, center.clone().addScaledVector( f.n, - 0.15 ), right, f.n ) );

			}

			// 2·3층 간판 (학원, 병원...)
			for ( const floorY of [ 7.0, 10.4 ] ) {

				if ( random() > 0.55 ) continue;

				for ( let k = 0; k < count; k ++ ) {

					if ( random() < 0.3 ) continue;
					const along = - f.len / 2 + slot * ( k + 0.5 );
					const w = Math.min( 5.2, slot * 0.7 );
					const h = w / 4;
					const center = f.c.clone().addScaledVector( right, along ).addScaledVector( f.n, 0.12 );
					center.y = curb + floorY + h / 2;
					quads.add( center, right, f.n, w / 2, h / 2, cells.h[ Math.floor( random() * cells.h.length ) ] );

				}

			}

			// 건물 모서리의 세로 돌출 간판
			for ( const end of [ - 1, 1 ] ) {

				if ( random() > 0.45 ) continue;
				const along = end * ( f.len / 2 - 1.4 );
				const hw = 0.5, hh = 2.1;
				const center = f.c.clone().addScaledVector( right, along ).addScaledVector( f.n, 0.3 + hw );
				center.y = curb + 5.8 + hh + random() * 4;
				const cell = cells.v[ Math.floor( random() * cells.v.length ) ];
				const back = right.clone().negate();
				quads.add( center.clone().addScaledVector( right, 0.07 ), f.n.clone().negate(), right, hw, hh, cell );
				quads.add( center.clone().addScaledVector( right, - 0.07 ), f.n.clone(), back, hw, hh, cell );
				backs.push( orientedBox( hw * 2 + 0.1, hh * 2 + 0.1, 0.12, center, f.n.clone(), right ) );
				backs.push( orientedBox( 0.08, 0.08, 0.35, center.clone().addScaledVector( f.n, - hw - 0.1 ).setY( center.y + hh - 0.3 ), right, f.n ) );

			}

		}

	};

	for ( const t of world.towers ) {

		const start = [ quads.position.length / 3, backs.length * BOX_VERTS, crossBars.length * BOX_VERTS ];
		signsOf( t );
		const end = [ quads.position.length / 3, backs.length * BOX_VERTS, crossBars.length * BOX_VERTS ];
		if ( end.some( ( e, k ) => e > start[ k ] ) ) ranges.set( t, { start, end } );

	}

	const group = new THREE.Group();
	group.name = 'SeoulSigns';
	const meshes = [ null, null, null ];

	const glow = uniform( 4 );
	const signMaterial = new THREE.MeshBasicNodeMaterial();
	signMaterial.colorNode = texture( map ).rgb.mul( glow );
	const signs = new THREE.Mesh( quads.build(), signMaterial );
	signs.name = 'Signs';
	group.add( signs );
	meshes[ 0 ] = signs;

	if ( backs.length ) {

		const backMesh = new THREE.Mesh( mergeGeometries( backs ), new THREE.MeshStandardMaterial( { color: 0x202124, metalness: 0.4, roughness: 0.55 } ) );
		backMesh.receiveShadow = true;
		group.add( backMesh );
		meshes[ 1 ] = backMesh;

	}

	if ( crossBars.length ) {

		const crossMaterial = new THREE.MeshBasicNodeMaterial();
		crossMaterial.colorNode = color( 1.0, 0.04, 0.05 ).mul( mix( 1.5, 40, nightness ) );
		meshes[ 2 ] = new THREE.Mesh( mergeGeometries( crossBars ), crossMaterial );
		group.add( meshes[ 2 ] );

	}

	// 빌딩이 날아가면 그 빌딩 간판의 정점을 한 점으로 모아 안 보이게 한다
	const remove = ( tower ) => {

		const r = ranges.get( tower );
		if ( ! r ) return;

		for ( let k = 0; k < 3; k ++ ) {

			const mesh = meshes[ k ];
			if ( ! mesh || r.end[ k ] <= r.start[ k ] ) continue;
			const p = mesh.geometry.attributes.position;
			for ( let i = r.start[ k ]; i < r.end[ k ]; i ++ ) p.setXYZ( i, 0, - 50, 0 );
			p.needsUpdate = true;

		}

		ranges.delete( tower );

	};

	return { group, glow, remove };

}

// ---------------------------------------------------------------------------
// 도로명 표지판 (파란 바탕) 과 초록 이정표

const STREETS_X = [ '퇴계로', '을지로', '종로', '세종대로', '삼일대로', '청계천로', '율곡로' ];
const STREETS_X_EN = [ 'Toegye-ro', 'Eulji-ro', 'Jong-ro', 'Sejong-daero', 'Samil-daero', 'Cheonggyecheon-ro', 'Yulgok-ro' ];
const STREETS_Z = [ '남대문로', '소공로', '명동길', '태평로', '충무로', '다산로', '장충단로', '동호로', '마른내로', '서애로', '수표로', '창경궁로', '돈화문로' ];
const STREETS_Z_EN = [ 'Namdaemun-ro', 'Sogong-ro', 'Myeongdong-gil', 'Taepyeong-ro', 'Chungmu-ro', 'Dasan-ro', 'Jangchungdan-ro', 'Dongho-ro', 'Mareunnae-ro', 'Seoae-ro', 'Supyo-ro', 'Changgyeonggung-ro', 'Donhwamun-ro' ];

function roadSignTexture( name, english, left, right ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 128;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#0a3d91';
	ctx.fillRect( 0, 0, 512, 128 );
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 5;
	ctx.strokeRect( 7, 7, 498, 114 );
	ctx.fillStyle = '#fff';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.font = `64px ${ FONT }`;
	ctx.fillText( name, 256, 52 );
	ctx.font = '24px "Jua", Arial, sans-serif';
	ctx.fillText( english, 256, 100 );
	ctx.font = 'bold 30px Arial, sans-serif';
	ctx.textAlign = 'left';
	ctx.fillText( '← ' + left, 18, 52 );
	ctx.textAlign = 'right';
	ctx.fillText( right + ' →', 494, 52 );
	const t = new THREE.CanvasTexture( canvas );
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;

}

function guideSignTexture() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 1024;
	canvas.height = 384;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#0b6b3a';
	ctx.fillRect( 0, 0, 1024, 384 );
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 8;
	ctx.strokeRect( 10, 10, 1004, 364 );
	ctx.fillStyle = '#fff';
	ctx.textBaseline = 'middle';

	const entry = ( x, arrow, ko, en ) => {

		ctx.textAlign = 'center';
		ctx.font = 'bold 120px Arial, sans-serif';
		ctx.fillText( arrow, x, 110 );
		ctx.font = `96px ${ FONT }`;
		ctx.fillText( ko, x, 238 );
		ctx.font = 'bold 34px Arial, sans-serif';
		ctx.fillText( en, x, 322 );

	};

	entry( 180, '←', '명동', 'Myeong-dong' );
	entry( 512, '↑', '남산', 'Namsan' );
	entry( 845, '→', '서울역', 'Seoul Station' );

	const t = new THREE.CanvasTexture( canvas );
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 8;
	return t;

}

export function buildStreetSigns( world ) {

	const group = new THREE.Group();
	group.name = 'StreetSigns';
	const pole = new THREE.MeshStandardMaterial( { color: 0x6c7076, metalness: 0.7, roughness: 0.4 } );
	const lit = ( map ) => {

		const m = new THREE.MeshBasicNodeMaterial();
		m.colorNode = texture( map ).rgb.mul( mix( 3.2, 2.2, nightness ) );
		return m;

	};

	const nameX = ( i ) => ( ( i % 7 ) + 7 ) % 7;
	const nameZ = ( j ) => ( ( j % 13 ) + 13 ) % 13;
	const top = world.curb;

	for ( let i = - 2; i <= 2; i ++ ) {

		for ( let j = - 3; j <= 3; j ++ ) {

			const cx = i * world.periodX, cz = j * world.periodZ;
			// 교차로 남동쪽 모퉁이에 기둥 하나, 두 방향으로 표지판
			const px = cx + world.street / 2 + 1.0, pz = cz + world.street / 2 + 1.0;
			const post = new THREE.Mesh( new THREE.CylinderGeometry( 0.07, 0.07, 4.2, 8 ), pole );
			post.position.set( px, top + 2.1, pz );
			group.add( post );

			// z 방향 도로(세로)의 이름: 가로 도로를 달리는 사람이 보도록 +x 를 향함
			const a = nameX( i + 3 );
			const signA = new THREE.Mesh( new THREE.PlaneGeometry( 1.9, 0.48 ), lit( roadSignTexture( STREETS_X[ a ], STREETS_X_EN[ a ], '1', String( 10 + ( ( j + 3 ) * 37 ) % 90 ) ) ) );
			signA.position.set( px - 0.05, top + 3.7, pz - 0.98 );
			signA.rotation.y = Math.PI / 2;
			group.add( signA );
			const signA2 = signA.clone();
			signA2.rotation.y = - Math.PI / 2;
			signA2.position.x = px + 0.05 - 0.1;
			group.add( signA2 );

			const b = nameZ( j + 6 );
			const signB = new THREE.Mesh( new THREE.PlaneGeometry( 1.9, 0.48 ), lit( roadSignTexture( STREETS_Z[ b ], STREETS_Z_EN[ b ], '1', String( 10 + ( ( i + 2 ) * 41 ) % 90 ) ) ) );
			signB.position.set( px - 0.98, top + 3.15, pz + 0.05 );
			group.add( signB );
			const signB2 = signB.clone();
			signB2.rotation.y = Math.PI;
			signB2.position.z = pz - 0.05;
			group.add( signB2 );

		}

	}

	// 남산 방향 초록 이정표 (내 앞길 위로)
	const guide = guideSignTexture();
	const gantry = new THREE.Group();
	const beam = new THREE.Mesh( new THREE.BoxGeometry( 24, 0.5, 0.5 ), pole );
	beam.position.y = 6.6;
	gantry.add( beam );

	for ( const x of [ - 11.6, 11.6 ] ) {

		const p = new THREE.Mesh( new THREE.CylinderGeometry( 0.22, 0.26, 7, 10 ), pole );
		p.position.set( x, 3.5, 0 );
		gantry.add( p );

	}

	const board = new THREE.Mesh( new THREE.PlaneGeometry( 8.4, 3.15 ), lit( guide ) );
	board.position.set( 3.8, 6.4, 0.3 );
	gantry.add( board );
	const boardBack = new THREE.Mesh( new THREE.BoxGeometry( 8.5, 3.25, 0.2 ), pole );
	boardBack.position.set( 3.8, 6.4, 0.15 );
	gantry.add( boardBack );
	gantry.position.set( 0, 0, - 40 );
	group.add( gantry );

	return group;

}

// ---------------------------------------------------------------------------
// 편의점 앞 플라스틱 테이블 (서울 밤 풍경)

export function buildPatio( position, facing ) {

	const group = new THREE.Group();
	const green = new THREE.MeshStandardMaterial( { color: 0x1f8a3a, roughness: 0.6 } );
	const red = new THREE.MeshStandardMaterial( { color: 0xd11f1f, roughness: 0.6 } );
	const white = new THREE.MeshStandardMaterial( { color: 0xf1f1ee, roughness: 0.5 } );
	const bottle = new THREE.MeshPhysicalMaterial( { color: 0x2f9e4a, roughness: 0.1, transmission: 0.6, thickness: 0.02 } );

	for ( let k = 0; k < 2; k ++ ) {

		const table = new THREE.Group();
		const top = new THREE.Mesh( new THREE.CylinderGeometry( 0.42, 0.42, 0.04, 24 ), white );
		top.position.y = 0.72;
		table.add( top );
		const leg = new THREE.Mesh( new THREE.CylinderGeometry( 0.04, 0.2, 0.7, 10 ), white );
		leg.position.y = 0.35;
		table.add( leg );

		for ( let b = 0; b < 3; b ++ ) {

			const s = new THREE.Mesh( new THREE.CylinderGeometry( 0.032, 0.032, 0.22, 10 ), bottle );
			s.position.set( Math.cos( b * 2.1 ) * 0.15, 0.85, Math.sin( b * 2.1 ) * 0.15 );
			table.add( s );

		}

		for ( let c = 0; c < 3; c ++ ) {

			const chair = new THREE.Group();
			const mat = c === 1 ? red : green;
			const seat = new THREE.Mesh( new THREE.BoxGeometry( 0.42, 0.04, 0.42 ), mat );
			seat.position.y = 0.44;
			chair.add( seat );
			const back = new THREE.Mesh( new THREE.BoxGeometry( 0.42, 0.42, 0.04 ), mat );
			back.position.set( 0, 0.66, - 0.2 );
			chair.add( back );

			for ( const [ x, z ] of [ [ - 0.18, - 0.18 ], [ 0.18, - 0.18 ], [ - 0.18, 0.18 ], [ 0.18, 0.18 ] ] ) {

				const l = new THREE.Mesh( new THREE.CylinderGeometry( 0.02, 0.025, 0.44, 6 ), mat );
				l.position.set( x, 0.22, z );
				chair.add( l );

			}

			const a = c / 3 * Math.PI * 2 + 0.4;
			chair.position.set( Math.cos( a ) * 0.75, 0, Math.sin( a ) * 0.75 );
			chair.rotation.y = - a - Math.PI / 2;
			table.add( chair );

		}

		// 파라솔
		const umbrella = new THREE.Mesh( new THREE.ConeGeometry( 1.25, 0.45, 12, 1, true ), red );
		umbrella.position.y = 2.25;
		table.add( umbrella );
		const pole = new THREE.Mesh( new THREE.CylinderGeometry( 0.02, 0.02, 2.2, 6 ), white );
		pole.position.y = 1.15;
		table.add( pole );

		table.position.set( 0, 0, k * 2.8 );
		group.add( table );

	}

	group.traverse( ( o ) => {

		if ( o.isMesh ) o.receiveShadow = true;

	} );

	group.position.copy( position );
	group.rotation.y = facing;
	return group;

}

// ---------------------------------------------------------------------------
// 원경: 남산 + N서울타워, 롯데월드타워, 63빌딩, 아파트 단지, 한강과 다리, 산

function hillMaterial( autumn = 1 ) {

	const m = new THREE.MeshStandardNodeMaterial( { roughness: 0.95 } );
	const n1 = mx_fractal_noise_float( positionWorld.mul( 0.012 ), 4 ).mul( 0.5 ).add( 0.5 );
	const n2 = mx_noise_float( positionWorld.mul( 0.05 ) ).mul( 0.5 ).add( 0.5 );
	const forest = mix( color( 0x1d3a1a ), color( 0x3a5a2c ), n2 );
	const fall = mix( color( 0x7a3a18 ), color( 0xa8772c ), n2 );
	const rock = color( 0x6c6a66 );
	const slope = normalWorld.y.oneMinus();
	const c = mix( forest, fall, smoothstep( 0.6, 0.85, n1 ).mul( autumn * 0.75 ) );
	m.colorNode = mix( c, rock, smoothstep( 0.35, 0.6, slope ).mul( 0.7 ) );
	return m;

}

const NAMSAN = { x: - 40, z: - 1180 };

function buildNamsan() {

	const group = new THREE.Group();
	group.name = 'Namsan';

	const hill = new THREE.Mesh( new THREE.SphereGeometry( 1, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2 ), hillMaterial() );
	hill.scale.set( 560, 235, 440 );
	group.add( hill );

	// N서울타워
	const tower = new THREE.Group();
	const concrete = new THREE.MeshStandardMaterial( { color: 0xe9e7e2, roughness: 0.6 } );

	const shaftMaterial = new THREE.MeshStandardNodeMaterial( { roughness: 0.5 } );
	shaftMaterial.colorNode = color( 0xe9e7e2 );
	const hue = sin( time.mul( 0.5 ).add( positionLocal.y.mul( 0.02 ) ) ).mul( 0.5 ).add( 0.5 );
	shaftMaterial.emissiveNode = mix( color( 0.15, 0.35, 1.0 ), color( 0.8, 0.2, 0.9 ), hue ).mul( nightness.mul( 2.5 ) );

	const base = new THREE.Mesh( new THREE.CylinderGeometry( 16, 18, 14, 32 ), concrete );
	base.position.y = 7;
	tower.add( base );

	const shaft = new THREE.Mesh( new THREE.CylinderGeometry( 3.4, 5.4, 140, 24 ), shaftMaterial );
	shaft.position.y = 14 + 70;
	tower.add( shaft );

	const deckMaterial = new THREE.MeshStandardNodeMaterial( { roughness: 0.25, metalness: 0.5 } );
	const band = step( 0.35, fract( positionLocal.y.div( 4 ) ) );
	deckMaterial.colorNode = mix( color( 0x2b3440 ), color( 0xdcdad5 ), band );
	deckMaterial.emissiveNode = color( 1.0, 0.75, 0.4 ).mul( band.oneMinus() ).mul( nightness.mul( 5 ) );

	const deck = new THREE.Mesh( new THREE.CylinderGeometry( 12, 9, 18, 40 ), deckMaterial );
	deck.position.y = 154 + 9;
	tower.add( deck );
	const deck2 = new THREE.Mesh( new THREE.CylinderGeometry( 8, 11, 6, 40 ), concrete );
	deck2.position.y = 175;
	tower.add( deck2 );

	const mastMaterial = new THREE.MeshStandardNodeMaterial( { roughness: 0.5 } );
	const stripe = step( 0.5, fract( positionLocal.y.div( 9 ) ) );
	mastMaterial.colorNode = mix( color( 0xd8261f ), color( 0xf2f2f2 ), stripe );
	mastMaterial.emissiveNode = color( 1, 0.1, 0.1 ).mul( stripe.oneMinus() ).mul( nightness.mul( 1.5 ) );
	const mast = new THREE.Mesh( new THREE.CylinderGeometry( 0.7, 2.2, 72, 12 ), mastMaterial );
	mast.position.y = 178 + 36;
	tower.add( mast );

	// 꼭대기 항공 장애등
	const beaconMaterial = new THREE.MeshBasicNodeMaterial();
	beaconMaterial.colorNode = color( 1, 0.05, 0.05 ).mul( sin( time.mul( 3 ) ).mul( 0.5 ).add( 0.5 ).mul( 60 ).add( 4 ) );
	const beacon = new THREE.Mesh( new THREE.SphereGeometry( 1.6, 12, 8 ), beaconMaterial );
	beacon.position.y = 252;
	tower.add( beacon );

	tower.position.y = 228;
	tower.scale.setScalar( 1.35 ); // 멀리서도 또렷하게
	group.add( tower );

	// 출발 지점에서 큰길 끝에 걸려 보이는 자리
	group.position.set( NAMSAN.x, - 2, NAMSAN.z );
	return group;

}

function buildLotteTower() {

	// 끝으로 갈수록 가늘어지는 정사각 단면의 555m 마천루
	const profile = [];
	for ( let i = 0; i <= 24; i ++ ) {

		const t = i / 24;
		profile.push( new THREE.Vector2( 34 * Math.pow( 1 - t, 0.75 ) * ( 1 - 0.12 * t ) + 2, t * 520 ) );

	}

	profile.push( new THREE.Vector2( 0.1, 556 ) );
	const geometry = new THREE.LatheGeometry( profile, 4 );
	geometry.rotateY( Math.PI / 4 );

	const m = new THREE.MeshStandardNodeMaterial( { metalness: 0.85, roughness: 0.16 } );
	const floorBand = step( 0.7, fract( positionLocal.y.div( 4.2 ) ) );
	m.colorNode = mix( color( 0xb9c4cf ), color( 0xe8edf2 ), floorBand );
	const lit = step( 0.45, hash( floor( positionLocal.y.div( 4.2 ) ).add( floor( positionLocal.x.add( positionLocal.z ).div( 6 ) ).mul( 31 ) ) ) );
	m.emissiveNode = color( 1.0, 0.85, 0.6 ).mul( lit.mul( floorBand.oneMinus() ) ).mul( nightness.mul( 2.2 ) ).add( color( 0.6, 0.8, 1.0 ).mul( smoothstep( 470, 540, positionLocal.y ) ).mul( nightness.mul( 6 ) ) );

	const tower = new THREE.Mesh( geometry, m );
	tower.name = 'LotteWorldTower';
	tower.position.set( 2300, - 1, 380 );
	return tower;

}

function build63() {

	const m = new THREE.MeshStandardNodeMaterial( { metalness: 1.0, roughness: 0.18 } );
	m.colorNode = mix( color( 0xc9952f ), color( 0xf0c86a ), step( 0.6, fract( positionLocal.y.div( 3.8 ) ) ) );
	m.emissiveNode = color( 1, 0.7, 0.3 ).mul( step( 0.8, fract( positionLocal.y.div( 3.8 ) ) ) ).mul( nightness.mul( 1.5 ) );
	const g = new THREE.BoxGeometry( 52, 250, 26 );
	g.translate( 0, 125, 0 );

	// 꼭대기로 갈수록 한쪽이 좁아지는 모양
	const pos = g.attributes.position;
	for ( let i = 0; i < pos.count; i ++ ) {

		const y = pos.getY( i );
		if ( y > 200 && pos.getX( i ) > 0 ) pos.setX( i, pos.getX( i ) - ( y - 200 ) * 0.4 );

	}

	g.computeVertexNormals();
	const mesh = new THREE.Mesh( g, m );
	mesh.name = '63Building';
	mesh.position.set( - 1900, - 1, 830 );
	mesh.rotation.y = 0.35;
	return mesh;

}

function apartmentMaterial() {

	// 흰 판상형 아파트: 층마다 창, 밤엔 무작위로 불이 켜진다
	const m = new THREE.MeshStandardNodeMaterial( { roughness: 0.8 } );
	const p = positionWorld;
	const sideways = abs( normalWorld.x ).greaterThan( abs( normalWorld.z ) );
	const bay = select( sideways, p.z, p.x );
	const fy = fract( p.y.div( 2.8 ) );
	const fb = fract( bay.div( 3.4 ) );
	const isWindow = step( 0.32, fy ).mul( step( fy, 0.82 ) ).mul( step( 0.12, fb ) ).mul( step( fb, 0.88 ) ).mul( step( 3, p.y ) );
	const roof = step( 0.5, normalWorld.y );
	const wall = mix( color( 0xe7e2d6 ), color( 0xcfc9bb ), step( 0.5, fract( p.y.div( 28 ) ) ).mul( 0.3 ) );
	const glass = color( 0x34404c );
	m.colorNode = mix( mix( wall, glass, isWindow ), color( 0x7a7c80 ), roof );
	const cell = floor( p.y.div( 2.8 ) ).mul( 131 ).add( floor( bay.div( 3.4 ) ) ).add( float( instanceIndex ).mul( 977 ) );
	const lit = step( 0.42, hash( cell ) );
	const warm = mix( color( 1.0, 0.78, 0.45 ), color( 0.85, 0.92, 1.0 ), step( 0.8, hash( cell.add( 7 ) ) ) );
	m.emissiveNode = warm.mul( isWindow.mul( lit ).mul( roof.oneMinus() ) ).mul( nightness.mul( 3.5 ) );
	return m;

}

function buildApartments( exclude ) {

	const random = createRandom( 63 );
	const matrices = [];
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	const p = new THREE.Vector3();
	const step = 150;

	for ( let x = - 3300; x <= 3300; x += step ) {

		for ( let z = - 3300; z <= 3300; z += step ) {

			if ( exclude( x, z ) || random() < 0.2 ) continue;

			const rows = 2 + Math.floor( random() * 3 );
			const yaw = ( random() - 0.5 ) * 0.35;
			q.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), yaw );
			const height = 42 + Math.floor( random() * 14 ) * 2.8;

			for ( let r = 0; r < rows; r ++ ) {

				const w = 48 + random() * 26;
				const h = height + ( random() < 0.3 ? 8.4 : 0 );
				const offset = new THREE.Vector3( ( random() - 0.5 ) * 30, 0, ( r - ( rows - 1 ) / 2 ) * 38 ).applyQuaternion( q );
				const px = x + offset.x, pz = z + offset.z;
				if ( exclude( px, pz ) ) continue;
				p.set( px, h / 2 - 0.3, pz );
				s.set( w, h, 13 );
				matrices.push( new THREE.Matrix4().compose( p, q, s ) );

			}

		}

	}

	const mesh = new THREE.InstancedMesh( new THREE.BoxGeometry( 1, 1, 1 ), apartmentMaterial(), matrices.length );
	matrices.forEach( ( m, i ) => mesh.setMatrixAt( i, m ) );
	mesh.name = 'Apartments';
	mesh.frustumCulled = false;
	return mesh;

}

function buildMountains() {

	const peaks = [
		[ - 1800, - 4300, 830, 1700 ], [ 900, - 4700, 640, 1400 ], [ 2900, - 3800, 520, 1200 ],
		[ - 4300, - 1700, 520, 1300 ], [ 4400, - 2300, 560, 1300 ], [ - 2600, 4600, 630, 1500 ],
		[ 2500, 4900, 480, 1300 ], [ 5300, 1600, 420, 1200 ], [ - 5300, 2300, 460, 1200 ], [ - 400, 5400, 420, 1400 ]
	];

	const geometries = [];
	const random = createRandom( 7 );

	for ( const [ px, pz, h, r ] of peaks ) {

		const g = new THREE.PlaneGeometry( r * 2, r * 2, 56, 56 ).rotateX( - Math.PI / 2 );
		const pos = g.attributes.position;
		const seed = random() * 100;

		for ( let i = 0; i < pos.count; i ++ ) {

			const x = pos.getX( i ), z = pos.getZ( i );
			const d = Math.hypot( x, z ) / r;
			const ridge = Math.sin( x * 0.004 + seed ) * Math.cos( z * 0.005 + seed * 1.3 ) * 0.25 + Math.sin( x * 0.013 + z * 0.011 + seed ) * 0.1;
			const shape = Math.max( 0, 1 - Math.pow( d, 1.4 ) );
			pos.setY( i, h * shape * ( 0.78 + ridge ) - 2 );

		}

		g.computeVertexNormals();
		g.translate( px, 0, pz );
		geometries.push( g );

	}

	const mesh = new THREE.Mesh( mergeGeometries( geometries ), hillMaterial( 0.35 ) );
	mesh.name = 'Mountains';
	return mesh;

}

function buildRiver() {

	const group = new THREE.Group();
	group.name = 'HanRiver';

	const water = new THREE.MeshStandardNodeMaterial( { metalness: 0.3, roughness: 0.08 } );
	const ripple = mx_noise_float( positionWorld.mul( vec3( 0.02, 0, 0.05 ) ).add( vec3( time.mul( 0.05 ), 0, 0 ) ) );
	water.colorNode = mix( color( 0x0d2a33 ), color( 0x1a4a55 ), ripple.mul( 0.5 ).add( 0.5 ) );
	const river = new THREE.Mesh( new THREE.PlaneGeometry( 14000, 760 ).rotateX( - Math.PI / 2 ), water );
	river.position.set( 0, - 0.12, 1260 );
	group.add( river );

	// 강변 둔치
	const bank = new THREE.MeshStandardMaterial( { color: 0x4f6b3a, roughness: 0.95 } );
	for ( const z of [ 860, 1660 ] ) {

		const b = new THREE.Mesh( new THREE.PlaneGeometry( 14000, 60 ).rotateX( - Math.PI / 2 ), bank );
		b.position.set( 0, - 0.08, z );
		group.add( b );

	}

	// 다리들: 상판, 교각, 가로등
	const concrete = new THREE.MeshStandardMaterial( { color: 0x9a9893, roughness: 0.7 } );
	const steel = new THREE.MeshStandardMaterial( { color: 0x2f6fb5, roughness: 0.4, metalness: 0.6 } );
	const lampMaterial = new THREE.MeshBasicNodeMaterial();
	lampMaterial.colorNode = color( 1, 0.8, 0.5 ).mul( mix( 0.8, 30, nightness ) );
	const lamps = [];
	const piers = [];

	for ( const [ x, arch ] of [ [ - 1100, true ], [ 150, false ], [ 1350, true ], [ 2700, false ] ] ) {

		const deck = new THREE.Mesh( new THREE.BoxGeometry( 26, 2.4, 900 ), concrete );
		deck.position.set( x, 14, 1260 );
		group.add( deck );

		for ( let z = 860; z <= 1660; z += 80 ) piers.push( new THREE.BoxGeometry( 5, 14, 9 ).translate( x, 7, z ) );
		for ( let z = 820; z <= 1700; z += 40 ) {

			lamps.push( new THREE.SphereGeometry( 0.7, 8, 6 ).translate( x - 12, 22, z ) );
			lamps.push( new THREE.SphereGeometry( 0.7, 8, 6 ).translate( x + 12, 22, z ) );

		}

		if ( arch ) {

			// 파란 아치 (한강 철교 느낌)
			for ( const side of [ - 11, 11 ] ) {

				for ( let k = 0; k < 3; k ++ ) {

					const a = new THREE.Mesh( new THREE.TorusGeometry( 120, 1.4, 8, 48, Math.PI ), steel );
					a.rotation.y = Math.PI / 2;
					a.scale.set( 1, 0.35, 1 );
					a.position.set( x + side, 15, 1020 + k * 240 );
					group.add( a );

				}

			}

		}

	}

	group.add( new THREE.Mesh( mergeGeometries( piers ), concrete ) );
	group.add( new THREE.Mesh( mergeGeometries( lamps ), lampMaterial ) );

	return group;

}

export function buildLandmarks( cityBounds ) {

	const group = new THREE.Group();
	group.name = 'SeoulSkyline';

	// 도시 바깥 땅
	const groundMaterial = new THREE.MeshStandardNodeMaterial( { roughness: 0.95 } );
	const n = mx_fractal_noise_float( positionWorld.mul( 0.004 ), 3 ).mul( 0.5 ).add( 0.5 );
	groundMaterial.colorNode = mix( color( 0x2a2c2f ), color( 0x3b4a33 ), smoothstep( 0.45, 0.7, n ) );
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 16000, 16000 ).rotateX( - Math.PI / 2 ), groundMaterial );
	ground.position.y = - 0.3;
	group.add( ground );

	const namsan = buildNamsan();
	group.add( namsan );
	group.add( buildLotteTower() );
	group.add( build63() );
	group.add( buildMountains() );
	group.add( buildRiver() );

	const hx = cityBounds.x + 50, hz = cityBounds.z + 50;
	const exclude = ( x, z ) => (
		( Math.abs( x ) < hx && Math.abs( z ) < hz ) || // 도시
		( Math.hypot( ( x - NAMSAN.x ) / 640, ( z - NAMSAN.z ) / 520 ) < 1 ) || // 남산
		( z > 800 && z < 1720 ) || // 한강
		Math.hypot( x - 2300, z - 380 ) < 160 || Math.hypot( x + 1900, z - 830 ) < 120
	);

	group.add( buildApartments( exclude ) );

	return group;

}
