// WebAudio 로 합성하는 효과음: 방구, 경적, 쿵, 자동차 경보, 폭발음

export class Sound {

	constructor() {

		this.ctx = null;
		this.fart = null;
		this.muted = false;

	}

	unlock() {

		if ( this.ctx ) {

			if ( this.ctx.state === 'suspended' ) this.ctx.resume();
			return;

		}

		const ctx = new ( window.AudioContext || window.webkitAudioContext )();
		this.ctx = ctx;

		const compressor = ctx.createDynamicsCompressor();
		compressor.threshold.value = - 12;
		compressor.ratio.value = 6;
		this.master = ctx.createGain();
		this.master.gain.value = 0.8;
		this.master.connect( compressor ).connect( ctx.destination );

		// 반복 재생용 백색 잡음
		const buffer = ctx.createBuffer( 1, ctx.sampleRate * 2, ctx.sampleRate );
		const data = buffer.getChannelData( 0 );
		for ( let i = 0; i < data.length; i ++ ) data[ i ] = Math.random() * 2 - 1;
		this.noise = buffer;

	}

	setMuted( muted ) {

		this.muted = muted;
		if ( this.master ) this.master.gain.setTargetAtTime( muted ? 0 : 0.8, this.ctx.currentTime, 0.05 );

	}

	noiseSource() {

		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.loop = true;
		src.loopStart = Math.random();
		return src;

	}

	// ---- 방구: 괄약근 떨림(톱니파) + 공기 새는 소리(잡음)
	startFart( p ) {

		if ( ! this.ctx ) return;
		this.stopFart( true );

		const ctx = this.ctx, now = ctx.currentTime;

		const osc = ctx.createOscillator();
		osc.type = 'sawtooth';
		osc.frequency.value = p.hz;

		const sub = ctx.createOscillator();
		sub.type = 'square';
		sub.frequency.value = p.hz * 0.5;

		const noise = this.noiseSource();
		const band = ctx.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = Math.min( 4000, p.hz * 3 + 200 );
		band.Q.value = p.hz > 250 ? 6 : 1.2;

		const oscGain = ctx.createGain();
		const subGain = ctx.createGain();
		const noiseGain = ctx.createGain();
		const big = Math.min( 1, p.force / 900 );
		oscGain.gain.value = 0.55;
		subGain.gain.value = 0.15 + big * 0.5;
		noiseGain.gain.value = p.hz > 250 ? 0.35 : 0.2 + big * 0.5;

		// 크면 찢어지는 소리
		const shaper = ctx.createWaveShaper();
		const curve = new Float32Array( 1024 );
		const k = 2 + big * 30;
		for ( let i = 0; i < 1024; i ++ ) {

			const x = i / 512 - 1;
			curve[ i ] = ( 1 + k ) * x / ( 1 + k * Math.abs( x ) );

		}

		shaper.curve = curve;

		const lowpass = ctx.createBiquadFilter();
		lowpass.type = 'lowpass';
		lowpass.frequency.value = Math.min( 9000, p.hz * 7 + 400 );
		lowpass.Q.value = 3;

		const amp = ctx.createGain();
		amp.gain.value = 0;
		amp.gain.setTargetAtTime( p.volume, now, 0.012 );

		osc.connect( oscGain ).connect( shaper );
		sub.connect( subGain ).connect( shaper );
		noise.connect( band ).connect( noiseGain ).connect( shaper );
		shaper.connect( lowpass ).connect( amp ).connect( this.master );

		osc.start( now );
		sub.start( now );
		noise.start( now );

		this.fart = { osc, sub, noise, amp, lowpass, band, p, t: 0, sputter: 1, nextSputter: 0 };

		if ( p.force > 300 ) this.boom( Math.min( 1, p.force / 1300 ) );

	}

	updateFart( dt, p ) {

		const f = this.fart;
		if ( ! f || ! this.ctx ) return;

		const now = this.ctx.currentTime;
		f.t += dt;

		// 떨림이 불규칙하게 흔들리고 가끔 끊겼다 이어진다 (뿌드드득)
		f.nextSputter -= dt;
		if ( f.nextSputter <= 0 ) {

			f.sputter = Math.random() < 0.28 ? 0.15 + Math.random() * 0.3 : 0.75 + Math.random() * 0.25;
			f.nextSputter = 0.025 + Math.random() * 0.07;

		}

		const wobble = 1 + Math.sin( f.t * 7.3 ) * 0.09 + Math.sin( f.t * 17.1 ) * 0.05 + ( Math.random() - 0.5 ) * 0.08;
		const droop = 1 - Math.min( 0.25, f.t * 0.05 ); // 길게 뀌면 음이 살짝 내려간다
		const hz = p.hz * wobble * droop;
		f.osc.frequency.setTargetAtTime( hz, now, 0.01 );
		f.sub.frequency.setTargetAtTime( hz * 0.5, now, 0.01 );
		f.amp.gain.setTargetAtTime( p.volume * f.sputter, now, 0.008 );

	}

	stopFart( immediate = false ) {

		const f = this.fart;
		if ( ! f || ! this.ctx ) return;

		const now = this.ctx.currentTime;
		const end = immediate ? 0.02 : 0.09;

		// 마지막에 "뿌웁" 하고 음이 떨어짐
		if ( ! immediate ) f.osc.frequency.setTargetAtTime( f.p.hz * 0.6, now, 0.04 );
		f.amp.gain.setTargetAtTime( 0, now, end / 3 );

		for ( const node of [ f.osc, f.sub, f.noise ] ) node.stop( now + end * 3 );

		this.fart = null;

	}

	boom( strength ) {

		const ctx = this.ctx, now = ctx.currentTime;

		const osc = ctx.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime( 110, now );
		osc.frequency.exponentialRampToValueAtTime( 28, now + 0.6 );
		const g = ctx.createGain();
		g.gain.setValueAtTime( 0.9 * strength, now );
		g.gain.exponentialRampToValueAtTime( 0.001, now + 0.9 );
		osc.connect( g ).connect( this.master );
		osc.start( now );
		osc.stop( now + 1 );

		const noise = this.noiseSource();
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime( 1200, now );
		lp.frequency.exponentialRampToValueAtTime( 80, now + 0.8 );
		const ng = ctx.createGain();
		ng.gain.setValueAtTime( 0.7 * strength, now );
		ng.gain.exponentialRampToValueAtTime( 0.001, now + 0.9 );
		noise.connect( lp ).connect( ng ).connect( this.master );
		noise.start( now );
		noise.stop( now + 1 );

	}

	// 빵빵! (거리에 따라 작아짐)
	honk( distance = 10 ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx, now = ctx.currentTime;
		const level = 0.35 / ( 1 + distance / 12 );

		for ( const start of [ 0, 0.22 ] ) {

			const g = ctx.createGain();
			g.gain.setValueAtTime( 0, now + start );
			g.gain.linearRampToValueAtTime( level, now + start + 0.015 );
			g.gain.setValueAtTime( level, now + start + 0.14 );
			g.gain.linearRampToValueAtTime( 0, now + start + 0.18 );

			const bp = ctx.createBiquadFilter();
			bp.type = 'bandpass';
			bp.frequency.value = 900;
			bp.Q.value = 0.8;
			bp.connect( g ).connect( this.master );

			for ( const hz of [ 392, 494 ] ) {

				const o = ctx.createOscillator();
				o.type = 'square';
				o.frequency.value = hz;
				o.connect( bp );
				o.start( now + start );
				o.stop( now + start + 0.2 );

			}

		}

	}

	// 착지 / 차 떨어지는 소리
	thud( strength = 1, distance = 0 ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx, now = ctx.currentTime;
		const level = strength / ( 1 + distance / 15 );

		const o = ctx.createOscillator();
		o.frequency.setValueAtTime( 90, now );
		o.frequency.exponentialRampToValueAtTime( 35, now + 0.25 );
		const g = ctx.createGain();
		g.gain.setValueAtTime( 0.8 * level, now );
		g.gain.exponentialRampToValueAtTime( 0.001, now + 0.4 );
		o.connect( g ).connect( this.master );
		o.start( now );
		o.stop( now + 0.45 );

		const n = this.noiseSource();
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 700;
		const ng = ctx.createGain();
		ng.gain.setValueAtTime( 0.5 * level, now );
		ng.gain.exponentialRampToValueAtTime( 0.001, now + 0.3 );
		n.connect( lp ).connect( ng ).connect( this.master );
		n.start( now );
		n.stop( now + 0.35 );

	}

	// 삐뽀삐뽀 자동차 경보
	alarm( distance = 20 ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx, now = ctx.currentTime;
		const level = 0.12 / ( 1 + distance / 20 );
		const o = ctx.createOscillator();
		o.type = 'square';
		const g = ctx.createGain();
		g.gain.value = level;

		for ( let i = 0; i < 12; i ++ ) o.frequency.setValueAtTime( i % 2 ? 1250 : 950, now + i * 0.25 );

		g.gain.setValueAtTime( level, now + 2.8 );
		g.gain.linearRampToValueAtTime( 0, now + 3 );
		o.connect( g ).connect( this.master );
		o.start( now );
		o.stop( now + 3 );

	}

	// 따르릉 자전거 벨
	bell( distance = 10 ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx, now = ctx.currentTime;
		const level = 0.1 / ( 1 + distance / 12 );

		for ( const f of [ 2350, 3170 ] ) {

			const o = ctx.createOscillator();
			o.frequency.value = f;
			const g = ctx.createGain();
			g.gain.value = 0;

			// 망치가 종을 여러 번 때린다
			for ( let i = 0; i < 9; i ++ ) {

				const t = now + i * 0.055;
				g.gain.setValueAtTime( level, t );
				g.gain.exponentialRampToValueAtTime( level * 0.25, t + 0.05 );

			}

			g.gain.exponentialRampToValueAtTime( 0.0001, now + 1.1 );
			o.connect( g ).connect( this.master );
			o.start( now );
			o.stop( now + 1.2 );

		}

	}

	// 행인 목소리: 모음 두 개(포먼트)를 거친 성대 소리로 "으엑", "하하하", "헉", "우와", "아 진짜"
	voice( type, distance = 10, female = false, variety = 0.5 ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx;
		const level = 0.09 / ( 1 + distance / 9 );
		if ( level < 0.004 ) return;
		const f0 = ( female ? 215 : 118 ) * ( 0.9 + variety * 0.2 );

		// [길이, F1, F2, 시작 음높이 배수, 끝 음높이 배수, 숨소리]
		const V = {
			disgust: [ [ 0.16, 360, 1350, 1.1, 1.0, 0.3 ], [ 0.22, 520, 1850, 1.15, 0.75, 0.25 ] ],
			laugh: [ [ 0.1, 800, 1250, 1.3, 1.25, 0.6 ], [ 0.1, 800, 1250, 1.35, 1.25, 0.6 ], [ 0.1, 800, 1250, 1.3, 1.2, 0.6 ], [ 0.14, 800, 1250, 1.25, 1.05, 0.6 ] ],
			scared: [ [ 0.05, 600, 1100, 1.4, 1.5, 0.9 ], [ 0.12, 620, 1050, 1.6, 1.3, 0.5 ] ],
			lookup: [ [ 0.2, 320, 800, 1.0, 1.25, 0.15 ], [ 0.32, 780, 1220, 1.35, 1.1, 0.15 ] ],
			angry: [ [ 0.18, 760, 1220, 1.05, 0.95, 0.2 ], [ 0.08, 300, 2200, 1.0, 1.0, 0.4 ], [ 0.2, 700, 1300, 1.1, 0.8, 0.25 ] ]
		}[ type ];
		if ( ! V ) return;

		let t = ctx.currentTime + 0.02 + Math.random() * 0.08;

		for ( const [ dur, f1, f2, p0, p1, breath ] of V ) {

			const src = ctx.createOscillator();
			src.type = 'sawtooth';
			src.frequency.setValueAtTime( f0 * p0, t );
			src.frequency.linearRampToValueAtTime( f0 * p1, t + dur );

			const mix = ctx.createGain();
			const out = ctx.createGain();
			out.gain.setValueAtTime( 0, t );
			out.gain.linearRampToValueAtTime( level, t + 0.02 );
			out.gain.setValueAtTime( level, t + dur * 0.7 );
			out.gain.linearRampToValueAtTime( 0, t + dur );

			for ( const [ f, q, g ] of [ [ f1, 6, 1 ], [ f2, 9, 0.6 ] ] ) {

				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = f * ( female ? 1.15 : 1 );
				bp.Q.value = q;
				const gain = ctx.createGain();
				gain.gain.value = g * ( 1 - breath * 0.6 );
				src.connect( bp ).connect( gain ).connect( mix );

			}

			// 숨소리
			if ( breath > 0 ) {

				const n = this.noiseSource();
				const hp = ctx.createBiquadFilter();
				hp.type = 'bandpass';
				hp.frequency.value = f2;
				hp.Q.value = 1.2;
				const ng = ctx.createGain();
				ng.gain.value = breath * 0.5;
				n.connect( hp ).connect( ng ).connect( mix );
				n.start( t );
				n.stop( t + dur );

			}

			mix.connect( out ).connect( this.master );
			src.start( t );
			src.stop( t + dur + 0.02 );
			t += dur + ( type === 'laugh' ? 0.05 : 0.02 );

		}

	}

	// 사람 비명 (짧게 미끄러지는 소리)
	scream( distance = 10, female = false ) {

		if ( ! this.ctx ) return;
		const ctx = this.ctx, now = ctx.currentTime;
		const level = 0.07 / ( 1 + distance / 10 );
		const base = female ? 720 : 430;
		const o = ctx.createOscillator();
		o.type = 'sawtooth';
		o.frequency.setValueAtTime( base, now );
		o.frequency.linearRampToValueAtTime( base * 1.5, now + 0.15 );
		o.frequency.exponentialRampToValueAtTime( base * 0.8, now + 0.9 );
		const vib = ctx.createOscillator();
		vib.frequency.value = 7;
		const vibGain = ctx.createGain();
		vibGain.gain.value = base * 0.04;
		vib.connect( vibGain ).connect( o.frequency );
		const formant = ctx.createBiquadFilter();
		formant.type = 'bandpass';
		formant.frequency.value = female ? 1500 : 1000;
		formant.Q.value = 2;
		const g = ctx.createGain();
		g.gain.setValueAtTime( 0, now );
		g.gain.linearRampToValueAtTime( level, now + 0.05 );
		g.gain.exponentialRampToValueAtTime( 0.0001, now + 1.0 );
		o.connect( formant ).connect( g ).connect( this.master );
		o.start( now );
		vib.start( now );
		o.stop( now + 1.05 );
		vib.stop( now + 1.05 );

	}

}
