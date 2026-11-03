import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute, texture, uniform, vec3, mix, float } from 'three/tsl';

// ---------------------------------------------------------------------------
// 방구 물리
//
// 장 속 가스가 일정한 압력 P 로 항문(지름 d)을 통해 분출된다고 보면
// 분출 추력은 F = 2·P·A  (A = π d² / 4) — 압력이 같으면 세기는 항문 넓이, 곧 지름의 제곱에 비례한다.
// 괄약근이 떨리는 진동수는 구멍이 클수록 낮아져서, 작은 구멍은 "삐익", 큰 구멍은 "부르르릉".

export const PRESSURE = 80000; // Pa, 배에 힘을 꽉 준 장내 압력 (만화 물리)
export const BODY_MASS = 70; // kg
export const G = 9.81;

export function fartPhysics( diameterMM ) {

	const d = diameterMM / 1000;
	const area = Math.PI * d * d / 4;
	const force = 2 * PRESSURE * area;
	const hz = THREE.MathUtils.clamp( 3200 / diameterMM, 24, 900 );
	const db = 50 + 16 * Math.log10( 1 + force );
	const reach = 3 + force / 35; // 가스 영향 반경 (m)

	let grade;
	if ( force < 10 ) grade = { name: '삐익~', tier: '모기 방구', color: '#9be15d' };
	else if ( force < 60 ) grade = { name: '뿡!', tier: '평범한 시민', color: '#d4e157' };
	else if ( force < 250 ) grade = { name: '뿌웅!!', tier: '국밥 세 그릇', color: '#ffca28' };
	else if ( force < 600 ) grade = { name: '뿌와아앙!!!', tier: '지하철 진동급', color: '#ff9800' };
	else if ( force < BODY_MASS * G / 0.8 ) grade = { name: '콰과광!!!!', tier: '지진 경보 발령', color: '#ff5722' };
	else grade = { name: '방구 로켓 발사!', tier: '이륙 가능', color: '#ff1744' };

	return { diameterMM, area, force, hz, db, reach, grade };

}

// 몸무게를 들어 올리는 지름 (추력의 세로 성분 0.8 F 가 체중을 넘는 지점)
export const LIFTOFF_DIAMETER = Math.sqrt( ( BODY_MASS * G / 0.8 ) / ( 2 * PRESSURE ) * 4 / Math.PI ) * 1000;

const WORDS = {
	tiny: [ '삐익~', '피식', '삐이익', '뽀옹' ],
	small: [ '뿡!', '뿡뿡', '뽕!', '부웅' ],
	mid: [ '뿌웅!!', '뿌르륵', '부우웅!!', '뿌직' ],
	big: [ '뿌와아앙!!!', '부르르르릉', '뿌다다닥!!', '콰르릉' ],
	huge: [ '콰과광!!!!', '쿠와아앙!!!', '부와아아앙', '드르르르륵!!' ]
};

function wordFor( force ) {

	const list = force < 10 ? WORDS.tiny : force < 60 ? WORDS.small : force < 250 ? WORDS.mid : force < 600 ? WORDS.big : WORDS.huge;
	return list[ Math.floor( Math.random() * list.length ) ];

}

// ---------------------------------------------------------------------------

const MAX = 1400;

function puffTexture() {

	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = 128;
	const ctx = canvas.getContext( '2d' );

	// 몽글몽글한 구름 한 덩이
	for ( let i = 0; i < 9; i ++ ) {

		const a = i / 9 * Math.PI * 2;
		const r = i === 0 ? 0 : 22 + Math.random() * 8;
		const x = 64 + Math.cos( a ) * r * ( i === 0 ? 0 : 1 ), y = 64 + Math.sin( a ) * r * ( i === 0 ? 0 : 1 );
		const rad = i === 0 ? 46 : 26 + Math.random() * 10;
		const g = ctx.createRadialGradient( x, y, 0, x, y, rad );
		g.addColorStop( 0, 'rgba(255,255,255,0.55)' );
		g.addColorStop( 0.6, 'rgba(255,255,255,0.25)' );
		g.addColorStop( 1, 'rgba(255,255,255,0)' );
		ctx.fillStyle = g;
		ctx.fillRect( 0, 0, 128, 128 );

	}

	const t = new THREE.CanvasTexture( canvas );
	t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

export class FartSystem {

	constructor( scene, sound ) {

		this.scene = scene;
		this.sound = sound;
		this.diameter = 28;
		this.physics = fartPhysics( this.diameter );
		this.tank = 1;
		this.active = false;
		this.force = 0;
		this.time = 0;
		this.minUntil = 0;
		this.emitCarry = 0;
		this.wordTimer = 0;
		this.events = []; // UI 로 넘길 의성어/알림
		this.shake = 0;
		this.totalFarts = 0;

		// ---- 가스 입자: 인스턴스 스프라이트 한 번의 드로우콜
		this.pos = new Float32Array( MAX * 3 );
		this.vel = new Float32Array( MAX * 3 );
		this.age = new Float32Array( MAX ).fill( 1e9 );
		this.life = new Float32Array( MAX );
		this.size0 = new Float32Array( MAX );
		this.next = 0;

		this.offsetAttr = new THREE.InstancedBufferAttribute( new Float32Array( MAX * 3 ), 3 );
		this.sizeAttr = new THREE.InstancedBufferAttribute( new Float32Array( MAX ), 1 );
		this.alphaAttr = new THREE.InstancedBufferAttribute( new Float32Array( MAX ), 1 );
		this.tintAttr = new THREE.InstancedBufferAttribute( new Float32Array( MAX ), 1 );
		for ( const a of [ this.offsetAttr, this.sizeAttr, this.alphaAttr, this.tintAttr ] ) a.setUsage( THREE.DynamicDrawUsage );

		const map = puffTexture();
		const material = new THREE.SpriteNodeMaterial( { transparent: true, depthWrite: false } );
		const tint = instancedDynamicBufferAttribute( this.tintAttr, 'float' );
		this.brightness = uniform( 6 );
		const fresh = vec3( 0.78, 0.85, 0.28 ); // 노르스름한 초록
		const old = vec3( 0.55, 0.6, 0.42 );
		const tex = texture( map );
		material.positionNode = instancedDynamicBufferAttribute( this.offsetAttr, 'vec3' );
		material.scaleNode = instancedDynamicBufferAttribute( this.sizeAttr, 'float' );
		material.colorNode = mix( fresh, old, tint ).mul( this.brightness ).mul( tex.r.mul( 0.5 ).add( 0.6 ) );
		material.opacityNode = tex.a.mul( instancedDynamicBufferAttribute( this.alphaAttr, 'float' ) );
		material.rotationNode = float( 0 );

		this.sprites = new THREE.Sprite( material );
		this.sprites.count = MAX;
		this.sprites.frustumCulled = false;
		this.sprites.renderOrder = 5;
		scene.add( this.sprites );

		// ---- 충격파 고리
		this.ring = new THREE.Mesh(
			new THREE.RingGeometry( 0.85, 1, 96 ).rotateX( - Math.PI / 2 ),
			new THREE.MeshBasicMaterial( { color: 0xfff3a0, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide } )
		);
		this.ring.renderOrder = 4;
		this.ring.visible = false;
		this.ringAge = 9;
		scene.add( this.ring );

	}

	setDiameter( mm ) {

		this.diameter = mm;
		this.physics = fartPhysics( mm );

	}

	get drainRate() {

		// 구멍이 클수록 가스가 빨리 빠진다 (초당 탱크 비율)
		return 0.1 + 0.3 * ( this.diameter / 100 );

	}

	refill() {

		this.tank = 1;

	}

	update( dt, held, me, nightness ) {

		this.time += dt;
		const p = this.physics;

		if ( held && ! this.wasHeld ) this.minUntil = this.time + 0.32; // 살짝 눌러도 한 번은 제대로
		this.wasHeld = held;

		const want = ( held || this.time < this.minUntil ) && this.tank > 0.001;

		if ( want && ! this.active ) this.begin( me );
		else if ( ! want && this.active ) this.end( this.tank <= 0.001 );

		if ( this.active ) {

			this.tank = Math.max( 0, this.tank - this.drainRate * dt );
			this.force = p.force * ( 0.85 + Math.random() * 0.3 );
			this.sound.updateFart( dt, { hz: p.hz, volume: this.volume() } );
			this.emit( dt, me );

			this.wordTimer -= dt;
			if ( this.wordTimer <= 0 ) {

				this.events.push( { type: 'word', text: wordFor( p.force ), force: p.force, color: p.grade.color } );
				this.wordTimer = 0.55 + Math.random() * 0.3;

			}

			this.shake = Math.min( 0.5, Math.pow( p.force, 0.6 ) / 260 );

		} else {

			this.force = 0;
			this.tank = Math.min( 1, this.tank + dt * 0.06 );
			this.shake *= Math.max( 0, 1 - dt * 6 );

		}

		this.simulate( dt, me );

		// 밤에는 가스가 가로등 빛에 덜 보이니 약간 어둡게
		this.brightness.value = THREE.MathUtils.lerp( 7, 2.2, nightness );

		// 충격파
		if ( this.ring.visible ) {

			this.ringAge += dt;
			const t = this.ringAge / 0.8;
			this.ring.scale.setScalar( 1 + t * this.ringRadius );
			this.ring.material.opacity = Math.max( 0, 0.7 * ( 1 - t ) );
			if ( t >= 1 ) this.ring.visible = false;

		}

	}

	volume() {

		return THREE.MathUtils.clamp( 0.12 + 0.55 * Math.pow( this.physics.force / 1300, 0.4 ), 0.1, 0.75 );

	}

	begin( me ) {

		this.active = true;
		this.totalFarts ++;
		const p = this.physics;
		this.force = p.force;
		this.sound.startFart( { hz: p.hz, volume: this.volume(), force: p.force } );
		this.wordTimer = 0;
		this.events.push( { type: 'start', force: p.force } );

		if ( p.force > 250 ) {

			this.ring.visible = true;
			this.ringAge = 0;
			this.ringRadius = p.reach * 1.2;
			this.ring.position.set( me.position.x, me.position.y + 0.05, me.position.z );
			this.events.push( { type: 'shock', force: p.force, radius: p.reach * 1.3 } );

		}

	}

	end( empty ) {

		this.active = false;
		this.sound.stopFart();
		if ( empty ) this.events.push( { type: 'empty' } );

	}

	emit( dt, me ) {

		const p = this.physics;
		const rate = 50 + p.diameterMM * 5.5; // 초당 입자 수
		this.emitCarry += rate * dt;

		const speed = 2 + Math.sqrt( p.force ) * 0.32;
		const spread = 0.35 + p.diameterMM / 250;
		const o = me.jetOrigin, d = me.jetDirection;
		const side = new THREE.Vector3( 1, 0, 0 ).cross( d ).normalize();
		const up = d.clone().cross( side ).normalize();

		while ( this.emitCarry >= 1 ) {

			this.emitCarry -= 1;
			const i = this.next;
			this.next = ( this.next + 1 ) % MAX;

			const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
			const dir = d.clone().addScaledVector( side, Math.cos( a ) * r ).addScaledVector( up, Math.sin( a ) * r ).normalize();
			const s = speed * ( 0.6 + Math.random() * 0.6 );

			this.pos[ i * 3 ] = o.x + ( Math.random() - 0.5 ) * 0.05;
			this.pos[ i * 3 + 1 ] = o.y + ( Math.random() - 0.5 ) * 0.05;
			this.pos[ i * 3 + 2 ] = o.z + ( Math.random() - 0.5 ) * 0.05;
			this.vel[ i * 3 ] = dir.x * s + me.velocity.x;
			this.vel[ i * 3 + 1 ] = dir.y * s + me.velocity.y;
			this.vel[ i * 3 + 2 ] = dir.z * s + me.velocity.z;
			this.age[ i ] = 0;
			this.life[ i ] = 1.4 + Math.random() * 1.5 + p.diameterMM / 70;
			this.size0[ i ] = 0.08 + p.diameterMM * 0.004;

		}

	}

	simulate( dt, me ) {

		const pos = this.pos, vel = this.vel;
		const off = this.offsetAttr.array, size = this.sizeAttr.array, alpha = this.alphaAttr.array, tint = this.tintAttr.array;
		const drag = Math.max( 0, 1 - dt * 2.2 );
		const t = this.time;

		for ( let i = 0; i < MAX; i ++ ) {

			const age = ( this.age[ i ] += dt );
			const life = this.life[ i ];

			if ( age >= life ) {

				alpha[ i ] = 0;
				size[ i ] = 0;
				continue;

			}

			const k = i * 3;
			vel[ k ] *= drag;
			vel[ k + 1 ] = vel[ k + 1 ] * drag + dt * 0.35; // 따뜻한 가스는 살짝 뜬다
			vel[ k + 2 ] *= drag;

			// 바람에 일렁임
			vel[ k ] += Math.sin( t * 1.3 + i ) * dt * 0.25;
			vel[ k + 2 ] += Math.cos( t * 1.1 + i * 0.7 ) * dt * 0.25;

			pos[ k ] += vel[ k ] * dt;
			pos[ k + 1 ] += vel[ k + 1 ] * dt;
			pos[ k + 2 ] += vel[ k + 2 ] * dt;

			// 땅에 부딪히면 옆으로 퍼진다
			if ( pos[ k + 1 ] < 0.1 ) {

				pos[ k + 1 ] = 0.1;
				vel[ k + 1 ] = Math.abs( vel[ k + 1 ] ) * 0.2;
				vel[ k ] *= 1.04;
				vel[ k + 2 ] *= 1.04;

			}

			off[ k ] = pos[ k ];
			off[ k + 1 ] = pos[ k + 1 ];
			off[ k + 2 ] = pos[ k + 2 ];

			const u = age / life;
			size[ i ] = this.size0[ i ] * ( 1 + u * 7 );
			alpha[ i ] = Math.min( 1, age * 12 ) * ( 1 - u ) * ( 1 - u ) * 0.75;
			tint[ i ] = u;

		}

		this.offsetAttr.needsUpdate = true;
		this.sizeAttr.needsUpdate = true;
		this.alphaAttr.needsUpdate = true;
		this.tintAttr.needsUpdate = true;

	}

}
