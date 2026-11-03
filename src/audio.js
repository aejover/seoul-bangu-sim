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

}
