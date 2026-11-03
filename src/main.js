import * as THREE from 'three/webgpu';
import { pass, fog, pmremTexture, positionWorld, cameraPosition, uniform, vec3, select, abs, exp, max } from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { CityGenerator, createBuildingMaterial } from 'three/addons/generators/CityGenerator.js';
import { MeshletDrawingPipeline } from 'three/addons/pipelines/MeshletDrawingPipeline.js';

import { World } from './world.js';
import { Character } from './character.js';
import { Traffic } from './traffic.js';
import { FartSystem, fartPhysics, LIFTOFF_DIAMETER } from './fart.js';
import { Sound } from './audio.js';
import { createSeoulRoadMaterial, makeGinkgo, buildSigns, buildStreetSigns, buildPatio, buildLandmarks, nightness } from './seoul.js';

const search = new URLSearchParams( location.search );

// 폰/태블릿은 가볍게 (?quality=low|high 로 강제)
const touch = matchMedia( '(pointer: coarse)' ).matches;
const quality = search.get( 'quality' ) || ( touch || Math.min( screen.width, screen.height ) < 600 ? 'low' : 'high' );
const low = quality === 'low';

const parameters = {
	seed: 94,
	tiles: parseInt( search.get( 'tiles' ) || ( low ? '4' : '6' ) ),
	timeOfDay: 17.4,
	pipeline: search.get( 'pipeline' ) || ( navigator.gpu ? 'meshlet' : 'default' ),
	haze: 1,
	cars: parseInt( search.get( 'cars' ) || ( low ? '24' : '40' ) ),
	pixelRatio: low ? 1 : 1.5,
	shadowSize: low ? 2048 : 4096
};

// 교차로 모퉁이 인도. 앞으로 길이 뚫려 있어 멀리 남산타워가 보인다
const SPAWN = new THREE.Vector3( 13.4, 0.15, 16.5 );
const CAMERA_OFFSET = new THREE.Vector3( 0.9, 0.3, 5.4 );

let camera, scene, renderer, controls, timer, renderPipeline, scenePass;
let sky, sun, sunLight, moonLight, pmremGenerator, envScene, envRenderTarget, cityBounds;
let city, world, me, traffic, fart, sound, signs;

const keys = {};
const stick = { x: 0, y: 0 };
let fartHeld = false;
let launchedTotal = 0;
let maxAltitude = 0;
let lastState = 'ground';
let frameCount = - 1;
const cameraFree = new THREE.Vector3();
const followTarget = new THREE.Vector3();

const $ = ( id ) => document.getElementById( id );
const setLoading = ( text ) => {

	$( 'loadingText' ).textContent = text;

};

init().catch( ( error ) => {

	console.error( error );
	setLoading( '불러오기 실패: ' + error.message + ' · 최신 Chrome / Edge / Safari 에서 열어 주세요' );

} );

async function init() {

	// 간판용 한글 폰트
	const fonts = Promise.all( [
		document.fonts.load( '80px "Black Han Sans"', '가나다치킨' ),
		document.fonts.load( '700 20px "Noto Sans KR"', '가' )
	] ).catch( () => {} );

	renderer = new THREE.WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, parameters.pixelRatio ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.13;
	renderer.shadowMap.enabled = true;
	$( 'app' ).appendChild( renderer.domElement );

	if ( parameters.pipeline === 'meshlet' ) {

		renderer.drawingPipeline = new MeshletDrawingPipeline( { occlusionCulling: true, depthPrepass: true, lodThreshold: 1.5, shadowLodThreshold: 1 } );

	}

	await renderer.init();

	pmremGenerator = new THREE.PMREMGenerator( renderer );
	scene = new THREE.Scene();
	scene.environmentIntensity = 0.2;

	sky = new SkyMesh();
	sky.scale.setScalar( 20000 );
	sky.turbidity.value = 8;
	sky.rayleigh.value = 3;
	sky.mieCoefficient.value = 0.008;
	sky.mieDirectionalG.value = 0.88;

	sun = new THREE.Vector3();
	envScene = new THREE.Scene();

	camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.3, 30000 );

	timer = new THREE.Timer();

	sunLight = new THREE.DirectionalLight();
	sunLight.castShadow = true;
	sunLight.shadow.mapSize.set( parameters.shadowSize, parameters.shadowSize );
	sunLight.shadow.normalBias = 0.05;
	sunLight.shadow.autoUpdate = false; // 도시는 움직이지 않으니 그림자는 해가 움직일 때만 다시 그린다
	scene.add( sunLight );

	// 해가 진 뒤의 푸르스름한 하늘빛
	moonLight = new THREE.HemisphereLight( 0x8ea6ff, 0x2b2a33, 0 );
	scene.add( moonLight );

	// ---- 도시
	setLoading( '도시 짓는 중...' );
	await fonts;
	generateCity();

	// 공기 원근 (예제와 같은 높이 감쇠 안개)
	const hazeDensity = uniform( 0.00035 * parameters.haze );
	const hazeFalloff = uniform( 1 / 250 );
	const ray = positionWorld.sub( cameraPosition );
	const distance = ray.length();
	const direction = ray.div( distance );
	const k = hazeFalloff.mul( direction.y ).mul( distance );
	const opticalDepth = hazeDensity.mul( exp( hazeFalloff.mul( max( cameraPosition.y, 0 ) ).negate() ) ).mul( distance ).mul( select( abs( k ).lessThan( 1e-4 ), 1, exp( k.negate() ).oneMinus().div( k ) ) );
	const skyColor = pmremTexture( envRenderTarget.texture, vec3( direction.x, max( direction.y, 0.02 ), direction.z ), 0.25 );
	scene.fogNode = fog( skyColor, exp( opticalDepth.negate() ).oneMinus() );

	renderPipeline = new THREE.RenderPipeline( renderer );
	scenePass = pass( scene, camera );
	const colorNode = scenePass.getTextureNode();
	const bloomPass = bloom( colorNode, 0.09, 0.25, 0.0 );
	bloomPass.setResolutionScale( 0.25 );
	renderPipeline.outputNode = colorNode.add( bloomPass );

	// ---- 나
	setLoading( '내 몸에 관절 넣는 중...' );
	sound = new Sound();
	me = new Character();
	await me.load();
	me.position.copy( SPAWN );
	me.yaw = Math.PI; // 남산 쪽(-z)을 본다
	scene.add( me.group );
	scene.add( me.shadow );
	me.group.traverse( ( o ) => {

		if ( o.isMesh ) o.receiveShadow = true;

	} );

	fart = new FartSystem( scene, sound );

	// ---- 페라리
	setLoading( '페라리 도로에 풀어놓는 중...' );
	traffic = new Traffic( scene, world, sound, { count: parameters.cars } );
	await traffic.load();

	// ---- 카메라
	controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 1.8;
	controls.maxDistance = 80;
	controls.maxPolarAngle = Math.PI * 0.53;
	snapCamera();

	setupUI();
	setupInput();

	window.addEventListener( 'resize', onWindowResize );

	setLoading( '셰이더 굽는 중...' );
	const started = performance.now();
	await Promise.race( [ scenePass.compileAsync( renderer ), new Promise( ( r ) => setTimeout( r, 6000 ) ) ] );
	console.log( `compile ${ Math.round( performance.now() - started ) } ms` );

	frameCount = 0;

	if ( search.has( 'bg' ) ) {

		// 창이 가려져 rAF 가 멈출 때 확인용 (?bg): GPU 가 끝날 때마다 다음 프레임
		const channel = new MessageChannel();
		const device = renderer.backend.device;
		channel.port1.onmessage = async () => {

			try {

				animate();

			} catch ( e ) {

				window.__err = e.message + '\n' + e.stack;
				console.error( e );

			}

			if ( device ) await device.queue.onSubmittedWorkDone();
			channel.port2.postMessage( 0 );

		};

		channel.port2.postMessage( 0 );

	} else {

		renderer.setAnimationLoop( animate );

	}
	window.__sim = { me, traffic, fart, world, camera, controls, scene, renderer, cameraFree, setTime: ( t ) => {

		parameters.timeOfDay = t;
		updateSun();

	} };

}

function snapCamera() {

	followTarget.copy( me.position ).add( new THREE.Vector3( 0, 1.3, 0 ) );
	controls.target.copy( followTarget );
	camera.position.copy( followTarget ).add( CAMERA_OFFSET );
	controls.update();
	cameraFree.copy( camera.position );

}

function generateCity() {

	city = new CityGenerator( { seed: parameters.seed } );

	const materials = {
		building: createBuildingMaterial( city.layout, city.seedNode, { interiors: true, weathering: false, relief: true } ),
		buildingFar: createBuildingMaterial( city.layout, city.seedNode, { interiors: 'average', weathering: false, relief: false } )
	};

	const cityGroup = city.build( materials );

	// 원래 있던 자동차는 전부 삭제
	const oldCars = [];
	cityGroup.traverse( ( o ) => {

		if ( o.name.startsWith( 'Car' ) ) oldCars.push( o );

	} );

	for ( const o of oldCars ) {

		o.removeFromParent();
		if ( o.geometry ) o.geometry.dispose();

	}

	makeGinkgo( cityGroup );

	// 멀리 있는 빌딩은 싼 재질 (예제와 같음)
	const skyscrapers = [];
	cityGroup.traverse( ( child ) => {

		if ( child.name === 'Skyscraper' ) skyscrapers.push( child );

	} );

	for ( const tower of skyscrapers ) {

		const lod = new THREE.LOD();
		lod.position.copy( tower.position );
		lod.quaternion.copy( tower.quaternion );
		lod.scale.copy( tower.scale );
		tower.parent.add( lod );
		tower.position.set( 0, 0, 0 );
		tower.quaternion.identity();
		tower.scale.set( 1, 1, 1 );
		const far = new THREE.Mesh( tower.geometry, materials.buildingFar );
		far.name = 'SkyscraperFar';
		far.castShadow = tower.castShadow;
		far.receiveShadow = tower.receiveShadow;
		lod.addLevel( tower, 0 );
		lod.addLevel( far, 340 );

	}

	const { cityW, cityD, street } = city.layout;
	const spanX = cityW + street;
	const spanZ = cityD + street;
	const tiles = parameters.tiles;
	const gpuDriven = parameters.pipeline === 'meshlet';
	const tilesGroup = gpuDriven ? new THREE.BundleGroup() : new THREE.Group();

	for ( let x = 0; x < tiles; x ++ ) {

		for ( let z = 0; z < tiles; z ++ ) {

			const tile = ( x === 0 && z === 0 ) ? cityGroup : cityGroup.clone();
			tile.position.set( ( x - ( tiles - 1 ) / 2 ) * spanX, 0, ( z - ( tiles - 1 ) / 2 ) * spanZ );
			tilesGroup.add( tile );
			clearAround( tile, 'People', SPAWN, 13 );

		}

	}

	scene.add( tilesGroup );

	const floorW = tiles * spanX + street;
	const floorD = tiles * spanZ + street;
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( floorW, floorD ).rotateX( - Math.PI / 2 ), createSeoulRoadMaterial( city.layout ) );
	ground.receiveShadow = true;
	scene.add( ground );

	cityBounds = new THREE.Box3( new THREE.Vector3( - floorW / 2, 0, - floorD / 2 ), new THREE.Vector3( floorW / 2, 160, floorD / 2 ) );

	world = new World( city, tiles );

	// ---- 서울 만들기
	signs = buildSigns( world, SPAWN );
	scene.add( signs.group );
	scene.add( buildStreetSigns( world ) );
	scene.add( buildPatio( new THREE.Vector3( SPAWN.x + 1.5, world.curb, SPAWN.z + 8.5 ), 0 ) );
	scene.add( buildLandmarks( { x: floorW / 2, z: floorD / 2 } ) );

	updateSun();

}

// 내가 서 있는 자리 주변의 보행자는 비켜 준다
function clearAround( tile, name, center, radius ) {

	const m = new THREE.Matrix4();
	const p = new THREE.Vector3();
	const zero = new THREE.Matrix4().makeScale( 0, 0, 0 );

	tile.traverse( ( o ) => {

		if ( o.name !== name || ! o.isInstancedMesh ) return;
		let changed = false;

		for ( let i = 0; i < o.count; i ++ ) {

			o.getMatrixAt( i, m );
			p.setFromMatrixPosition( m ).add( tile.position );

			if ( Math.hypot( p.x - center.x, p.z - center.z ) < radius ) {

				o.setMatrixAt( i, zero );
				changed = true;

			}

		}

		if ( changed ) o.instanceMatrix.needsUpdate = true;

	} );

}

function updateSun() {

	const t = parameters.timeOfDay;
	const u = ( t - 12 ) / 6;
	const elevation = t <= 18 ? Math.max( 0, 1 - u * u ) * 72 : - ( t - 18 ) * 9; // 18시 이후엔 해가 지평선 아래로
	const azimuth = 90 - Math.min( u, 1.15 ) * 55;

	sun.setFromSphericalCoords( 1, THREE.MathUtils.degToRad( 90 - elevation ), THREE.MathUtils.degToRad( azimuth ) );
	sky.sunPosition.value.copy( sun );

	const sinElevation = Math.sin( THREE.MathUtils.degToRad( elevation ) );
	const transmittance = Math.sqrt( Math.max( sinElevation, 0 ) );
	sunLight.color.set( 0xffb072 ).lerp( new THREE.Color( 0xfff4e8 ), transmittance );
	sunLight.intensity = 100 * transmittance;
	sunLight.position.copy( sun ).multiplyScalar( 4000 );

	const shadowCamera = sunLight.shadow.camera;
	const lightSpace = new THREE.Quaternion().setFromRotationMatrix( new THREE.Matrix4().lookAt( sunLight.position, scene.position, THREE.Object3D.DEFAULT_UP ) ).invert();
	const fit = new THREE.Box3();
	const corner = new THREE.Vector3();

	for ( let i = 0; i < 8; i ++ ) {

		corner.set(
			i & 1 ? cityBounds.max.x : cityBounds.min.x,
			i & 2 ? cityBounds.max.y : cityBounds.min.y,
			i & 4 ? cityBounds.max.z : cityBounds.min.z
		).sub( sunLight.position ).applyQuaternion( lightSpace );
		fit.expandByPoint( corner );

	}

	const pad = 2;
	shadowCamera.left = fit.min.x - pad;
	shadowCamera.right = fit.max.x + pad;
	shadowCamera.bottom = fit.min.y - pad;
	shadowCamera.top = fit.max.y + pad;
	shadowCamera.near = - fit.max.z - pad;
	shadowCamera.far = - fit.min.z + pad;
	shadowCamera.updateProjectionMatrix();

	sky.showSunDisc.value = false;
	envScene.add( sky );
	envRenderTarget = pmremGenerator.fromScene( envScene, 0, 0.1, 100, { renderTarget: envRenderTarget } );
	scene.environment = envRenderTarget.texture;
	sky.showSunDisc.value = true;

	sunLight.shadow.needsUpdate = true;
	scene.add( sky );

	// 저녁이 되면 간판과 창문이 켜진다
	const night = THREE.MathUtils.smoothstep( t, 16.6, 18.9 ) + ( 1 - THREE.MathUtils.smoothstep( t, 5.8, 7.0 ) );
	nightness.value = THREE.MathUtils.clamp( night, 0, 1 );
	moonLight.intensity = nightness.value * 5;
	scene.environmentIntensity = 0.2 + nightness.value * 0.25;
	renderer.toneMappingExposure = THREE.MathUtils.lerp( 0.13, 0.32, Math.max( 0, ( t - 18 ) / 1.5 ) );
	if ( signs ) signs.glow.value = THREE.MathUtils.lerp( 4.5, 11, nightness.value );
	if ( traffic ) traffic.lightLevel.value = nightness.value;

}

// ---------------------------------------------------------------------------
// UI

function setupUI() {

	const slider = $( 'diameter' );
	const time = $( 'time' );

	const refresh = () => {

		const d = parseFloat( slider.value );
		fart.setDiameter( d );
		const p = fartPhysics( d );
		$( 'diameterValue' ).textContent = `${ d } mm`;
		$( 'statArea' ).textContent = `${ ( p.area * 1e4 ).toFixed( p.area * 1e4 < 1 ? 2 : 1 ) } cm²`;
		$( 'statForce' ).textContent = `${ p.force < 10 ? p.force.toFixed( 1 ) : Math.round( p.force ) } N`;
		$( 'statDb' ).textContent = `${ Math.round( p.db ) } dB`;
		$( 'statHz' ).textContent = `${ Math.round( p.hz ) } Hz`;
		$( 'statReach' ).textContent = `${ p.reach.toFixed( 1 ) } m`;
		$( 'gradeName' ).textContent = p.grade.name;
		$( 'gradeName' ).style.color = p.grade.color;
		$( 'gradeTier' ).textContent = p.grade.tier + ( d >= LIFTOFF_DIAMETER ? '' : ` · 이륙까지 ${ Math.ceil( LIFTOFF_DIAMETER - d ) } mm` );
		$( 'ringHole' ).setAttribute( 'r', ( 3 + d / 110 * 51 ).toFixed( 1 ) );
		$( 'ringLift' ).setAttribute( 'r', ( 3 + LIFTOFF_DIAMETER / 110 * 51 ).toFixed( 1 ) );

	};

	slider.addEventListener( 'input', refresh );
	refresh();

	const refreshTime = () => {

		parameters.timeOfDay = parseFloat( time.value );
		const h = Math.floor( parameters.timeOfDay ), m = Math.round( ( parameters.timeOfDay - h ) * 60 );
		$( 'timeValue' ).textContent = `${ String( h ).padStart( 2, '0' ) }:${ String( m ).padStart( 2, '0' ) }`;

	};

	let timeQueued = false;
	time.addEventListener( 'input', () => {

		refreshTime();
		if ( timeQueued ) return;
		timeQueued = true;
		requestAnimationFrame( () => {

			timeQueued = false;
			updateSun();

		} );

	} );
	refreshTime();

	const button = $( 'fartButton' );
	const press = ( e ) => {

		e.preventDefault();
		sound.unlock();
		fartHeld = true;
		button.classList.add( 'on' );
		button.setPointerCapture?.( e.pointerId );

	};

	const release = () => {

		fartHeld = keys.Space === true;
		button.classList.remove( 'on' );

	};

	button.addEventListener( 'pointerdown', press );
	button.addEventListener( 'pointerup', release );
	button.addEventListener( 'pointercancel', release );

	$( 'eatButton' ).addEventListener( 'click', () => {

		sound.unlock();
		fart.refill();
		toast( '고구마 냠냠 🍠 가스 100% 충전!' );

	} );

	$( 'mute' ).addEventListener( 'change', ( e ) => {

		sound.unlock();
		sound.setMuted( e.target.checked );

	} );

}

function setupInput() {

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' ) return;
		keys[ e.code ] = true;
		sound.unlock();

		if ( e.code === 'Space' ) {

			e.preventDefault();
			fartHeld = true;
			$( 'fartButton' ).classList.add( 'on' );

		}

		if ( e.code === 'KeyR' ) {

			me.position.copy( SPAWN );
			me.velocity.set( 0, 0, 0 );
			me.yaw = Math.PI;
			me.setState( 'ground' );
			controls.maxDistance = 80;
			snapCamera();

		}

		if ( [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].includes( e.code ) ) e.preventDefault();

	} );

	window.addEventListener( 'keyup', ( e ) => {

		keys[ e.code ] = false;

		if ( e.code === 'Space' ) {

			fartHeld = false;
			$( 'fartButton' ).classList.remove( 'on' );

		}

	} );

	window.addEventListener( 'blur', () => {

		for ( const k in keys ) keys[ k ] = false;
		fartHeld = false;

	} );

	renderer.domElement.addEventListener( 'pointerdown', () => sound.unlock() );

	// 터치 조이스틱 (화면 왼쪽 아래)
	const pad = $( 'stick' );
	const knob = $( 'stickKnob' );
	let stickId = null;

	const moveStick = ( e ) => {

		const r = pad.getBoundingClientRect();
		const radius = r.width / 2;
		let x = ( e.clientX - r.left - radius ) / radius;
		let y = ( e.clientY - r.top - radius ) / radius;
		const length = Math.hypot( x, y );
		if ( length > 1 ) { x /= length; y /= length; }
		stick.x = x;
		stick.y = y;
		knob.style.transform = `translate(${ x * radius * 0.6 }px, ${ y * radius * 0.6 }px)`;

	};

	const endStick = ( e ) => {

		if ( e.pointerId !== stickId ) return;
		stickId = null;
		stick.x = stick.y = 0;
		knob.style.transform = '';

	};

	pad.addEventListener( 'pointerdown', ( e ) => {

		e.preventDefault();
		sound.unlock();
		stickId = e.pointerId;
		pad.setPointerCapture( e.pointerId );
		moveStick( e );

	} );
	pad.addEventListener( 'pointermove', ( e ) => {

		if ( e.pointerId === stickId ) moveStick( e );

	} );
	pad.addEventListener( 'pointerup', endStick );
	pad.addEventListener( 'pointercancel', endStick );

}

function gatherInput() {

	if ( window.__debugInput ) return window.__debugInput;

	const clamp = ( v ) => Math.max( - 1, Math.min( 1, v ) );
	const f = clamp( ( keys.KeyW || keys.ArrowUp ? 1 : 0 ) - ( keys.KeyS || keys.ArrowDown ? 1 : 0 ) - stick.y );
	const r = clamp( ( keys.KeyD || keys.ArrowRight ? 1 : 0 ) - ( keys.KeyA || keys.ArrowLeft ? 1 : 0 ) + stick.x );

	// 카메라 기준 이동 방향
	const forward = new THREE.Vector3();
	camera.getWorldDirection( forward );
	forward.y = 0;
	forward.normalize();
	const right = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) );
	const move = forward.multiplyScalar( f ).addScaledVector( right, r );

	// 조이스틱을 끝까지 밀면 달리기
	return { move, run: keys.ShiftLeft || keys.ShiftRight || Math.hypot( stick.x, stick.y ) > 0.9, forward: f, turn: r };

}

let lastToast = { text: '', time: 0 };

function toast( text ) {

	// 같은 알림이 연달아 쌓이지 않게
	const now = performance.now();
	if ( text === lastToast.text && now - lastToast.time < 2500 ) return;
	lastToast = { text, time: now };

	const el = document.createElement( 'div' );
	el.textContent = text;
	$( 'toast' ).appendChild( el );
	setTimeout( () => el.remove(), 2700 );
	while ( $( 'toast' ).children.length > 3 ) $( 'toast' ).firstChild.remove();

}

function popWord( text, position, force, color ) {

	const v = position.clone().project( camera );
	if ( v.z > 1 ) return;
	const el = document.createElement( 'div' );
	el.className = 'word';
	el.textContent = text;
	const size = 20 + 15 * Math.log10( 1 + force );
	el.style.fontSize = `${ size }px`;
	el.style.color = color;
	el.style.left = `${ ( v.x * 0.5 + 0.5 ) * window.innerWidth + ( Math.random() - 0.5 ) * 80 }px`;
	el.style.top = `${ ( - v.y * 0.5 + 0.5 ) * window.innerHeight + ( Math.random() - 0.5 ) * 40 }px`;
	el.style.setProperty( '--r', `${ ( Math.random() - 0.5 ) * 24 }deg` );
	el.style.setProperty( '--dx', `${ ( Math.random() - 0.5 ) * 120 }px` );
	$( 'words' ).appendChild( el );
	setTimeout( () => el.remove(), 1400 );

}

// 카메라가 건물 속으로 들어가지 않도록 나와 카메라 사이를 훑어 벽 앞에서 멈춘다
function keepCameraOutside() {

	const from = controls.target;
	const to = camera.position;
	const dir = to.clone().sub( from );
	const length = dir.length();
	dir.divideScalar( length );
	const p = new THREE.Vector3();

	for ( let d = 0.3; d <= length; d += 0.25 ) {

		p.copy( from ).addScaledVector( dir, d );

		if ( world.heightAt( p.x, p.z ) > p.y - 0.3 ) {

			camera.position.copy( from ).addScaledVector( dir, Math.max( 0.4, d - 0.4 ) );
			return;

		}

	}

	if ( camera.position.y < 0.4 ) camera.position.y = 0.4;

}

function onWindowResize() {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

}

// ---------------------------------------------------------------------------

function animate() {

	timer.update();
	const dt = Math.min( 0.05, timer.getDelta() );

	const input = gatherInput();

	fart.update( dt, fartHeld, me, nightness.value );
	me.update( dt, input, world, fart );
	traffic.update( dt, me, fart );

	// 방구 이벤트
	for ( const e of fart.events ) {

		if ( e.type === 'word' ) popWord( e.text, me.jetOrigin, e.force, e.color );
		else if ( e.type === 'shock' ) traffic.shock( me.position, e.force, e.radius );
		else if ( e.type === 'empty' ) toast( '가스 부족! 고구마를 드세요 🍠' );

	}

	fart.events.length = 0;

	for ( const e of traffic.events ) {

		if ( e.type === 'launch' ) {

			launchedTotal += e.count;
			$( 'counter' ).textContent = `날려버린 페라리 ${ launchedTotal }대`;
			toast( `페라리 ${ e.count }대 날아감! 💨` );

		} else if ( e.type === 'honk' && Math.random() < 0.5 ) {

			popWord( '빵빵!', e.pos.clone().setY( 1.6 ), 20, '#ffffff' );

		}

	}

	traffic.events.length = 0;

	// 상태 변화 알림
	if ( me.state !== lastState ) {

		if ( me.state === 'air' && fart.active ) toast( '🚀 방구 로켓 이륙!' );
		if ( lastState === 'air' ) {

			sound.thud( Math.min( 1, ( me.lastImpact || 0 ) / 10 ) );
			if ( me.state === 'down' ) {

				toast( '쿵! 엉덩방아 🤕' );
				popWord( '쿵!', me.position.clone().setY( me.position.y + 0.5 ), 300, '#ffffff' );

			}

		}

		lastState = me.state;

	}

	// 비행 정보
	const altitude = Math.max( 0, me.position.y - world.heightAt( me.position.x, me.position.z ) );
	const flying = me.state === 'air';
	$( 'flight' ).hidden = ! flying;

	if ( flying ) {

		maxAltitude = Math.max( maxAltitude, me.position.y );
		$( 'altitude' ).textContent = me.position.y.toFixed( 0 );
		$( 'speed' ).textContent = ( me.velocity.length() * 3.6 ).toFixed( 0 );

	}

	$( 'tankBar' ).style.width = `${ fart.tank * 100 }%`;
	$( 'tankText' ).textContent = `${ Math.round( fart.tank * 100 ) }%`;

	// 카메라: 나를 따라가고, 벽에 막히면 당겨지고, 방구 세기만큼 흔들린다
	camera.position.copy( cameraFree );
	const target = me.position.clone().add( new THREE.Vector3( 0, me.state === 'down' ? 0.4 : 1.3, 0 ) );
	const delta = target.clone().sub( followTarget ).multiplyScalar( Math.min( 1, dt * ( flying ? 6 : 10 ) ) );
	followTarget.add( delta );
	camera.position.add( delta );
	controls.target.copy( followTarget );
	if ( flying && altitude > 8 ) controls.maxDistance = 120;
	controls.update();
	cameraFree.copy( camera.position );
	keepCameraOutside();

	const s = fart.shake;
	camera.position.add( new THREE.Vector3( ( Math.random() - 0.5 ) * s, ( Math.random() - 0.5 ) * s, ( Math.random() - 0.5 ) * s ) );

	// 확인용 고정 카메라
	if ( window.__freeCam ) {

		camera.position.copy( window.__freeCam.pos );
		camera.lookAt( window.__freeCam.target );

	}

	renderPipeline.render();

	// 첫 몇 프레임이 그려지면 로딩 화면을 걷는다
	window.__frames = frameCount + 1;
	if ( ++ frameCount === 3 ) {

		$( 'loading' ).classList.add( 'done' );
		toast( touch ? '서울 도착! 방구 버튼을 꾹 눌러 보세요' : '서울 도착! Space 를 꾹 눌러 방구를 뀌어 보세요' );

	}

}
