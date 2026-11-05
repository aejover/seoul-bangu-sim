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
import { FartSystem, fartPhysics, LIFTOFF_DIAMETER, LIFTOFF_FORCE, LIGHT_LAUNCH_FORCE } from './fart.js';
import { Sound } from './audio.js';
import { People } from './people.js';
import { Destruction } from './destruction.js';
import { Director, CAMERA_MODES } from './director.js';
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
	walkers: parseInt( search.get( 'people' ) || ( low ? '14' : '30' ) ),
	cyclists: parseInt( search.get( 'bikes' ) || ( low ? '4' : '8' ) ),
	pixelRatio: low ? 1 : 1.5,
	shadowSize: low ? 2048 : 4096
};

// 교차로 모퉁이 인도. 앞으로 길이 뚫려 있어 멀리 남산타워가 보인다
const SPAWN = new THREE.Vector3( 13.4, 0.15, 16.5 );
const CAMERA_OFFSET = new THREE.Vector3( 0.9, 0.3, 5.4 );

let camera, scene, renderer, controls, timer, renderPipeline, scenePass;
let sky, sun, sunLight, moonLight, pmremGenerator, envScene, envRenderTarget, cityBounds;
let city, world, me, traffic, fart, sound, signs, people, tilesGroup, destruction, director;
let controlYaw = Math.PI;
let destroyedTotal = 0;
let nearCar = null;
const directorEvents = [];
const droneInput = { forward: 0, right: 0, up: 0, fast: false };
let firstFrameTime = 0;
let recording = false;
let loadingDone = false;

const keys = {};
const stick = { x: 0, y: 0 };
let fartHeld = false;
let launchedTotal = 0;
let maxAltitude = 0;
let lastState = 'ground';
let frameCount = - 1;
const cameraFree = new THREE.Vector3();
const _carVel = new THREE.Vector3();
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
		document.fonts.load( '700 20px "Noto Sans KR"', '가나다' ),
		document.fonts.load( '80px "Cafe24Ssurround"', '가나다치킨편의점' )
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

	// ---- 사람들
	setLoading( '서울 사람들 얼굴 만드는 중...' );
	people = new People( scene, world, sound, { walkers: parameters.walkers, cyclists: parameters.cyclists } );
	await people.load();
	people.spawnAll( SPAWN );

	destruction = new Destruction( scene, tilesGroup, world, sunLight, sound );
	destruction.onTower = ( box ) => signs.remove( box );

	// ---- 카메라
	controls = new OrbitControls( camera, renderer.domElement );
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 1.8;
	controls.maxDistance = 80;
	controls.maxPolarAngle = Math.PI * 0.53;
	snapCamera();

	director = new Director( camera, world, renderer.domElement );

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
	window.__sim = { me, traffic, fart, world, camera, controls, scene, renderer, cameraFree, people, destruction, director, setCameraMode, toggleCar, setTime: ( t ) => {

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

	// 원래 있던 자동차와 가만히 서 있는 사람들은 전부 삭제 (관절 있는 사람들로 바꾼다)
	const oldCars = [];
	cityGroup.traverse( ( o ) => {

		if ( o.name.startsWith( 'Car' ) || o.name === 'People' ) oldCars.push( o );

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
	tilesGroup = gpuDriven ? new THREE.BundleGroup() : new THREE.Group();

	for ( let x = 0; x < tiles; x ++ ) {

		for ( let z = 0; z < tiles; z ++ ) {

			const tile = ( x === 0 && z === 0 ) ? cityGroup : cityGroup.clone();
			tile.position.set( ( x - ( tiles - 1 ) / 2 ) * spanX, 0, ( z - ( tiles - 1 ) / 2 ) * spanZ );
			tilesGroup.add( tile );

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
	// 한낮 햇빛은 너무 눈부시지 않게 (해질녘 노을빛은 그대로)
	sunLight.intensity = 100 * transmittance * ( 1 - 0.38 * transmittance );
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
	renderer.toneMappingExposure = THREE.MathUtils.lerp( 0.13 - 0.025 * transmittance, 0.32, Math.max( 0, ( t - 18 ) / 1.5 ) );
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

	} );

	$( 'mute' ).addEventListener( 'change', ( e ) => {

		sound.unlock();
		sound.setMuted( e.target.checked );

	} );

	// 카메라 시점 버튼
	const row = $( 'cameraModes' );

	for ( const [ i, m ] of CAMERA_MODES.entries() ) {

		const b = document.createElement( 'button' );
		b.dataset.mode = m.id;
		b.innerHTML = `${ m.label }<small>${ i + 1 }</small>`;
		b.addEventListener( 'click', () => setCameraMode( m.id ) );
		row.appendChild( b );

	}

	refreshCameraButtons();

	$( 'carButton' ).addEventListener( 'click', () => {

		sound.unlock();
		toggleCar();

	} );

	$( 'danceButton' ).addEventListener( 'click', () => {

		sound.unlock();
		toggleDance();

	} );

	$( 'recordButton' ).addEventListener( 'click', () => setRecording( true ) );

	// 드론 속도
	$( 'droneSpeed' ).addEventListener( 'input', () => setDroneSpeed( parseFloat( $( 'droneSpeed' ).value ) ) );

	// 폰에는 Enter 가 없으니 화면을 두 번 톡톡 치면 녹화 모드가 끝난다
	let lastTap = 0;
	renderer.domElement.addEventListener( 'pointerup', ( e ) => {

		if ( ! recording || e.pointerType !== 'touch' ) return;
		if ( performance.now() - lastTap < 300 ) setRecording( false );
		lastTap = performance.now();

	} );

	$( 'resetButton' ).addEventListener( 'click', () => {

		sound.unlock();
		resetSimulation();

	} );

	// 설정 접기 / 펼치기 (폰에서는 처음에 접어 둔다)
	const panel = $( 'panel' );
	let collapsed = touch;
	try {

		const saved = localStorage.getItem( 'settingsCollapsed' );
		if ( saved !== null ) collapsed = saved === '1';

	} catch ( e ) { /* 저장소를 못 쓰면 기본값 */ }

	const applyCollapse = () => {

		panel.classList.toggle( 'collapsed', collapsed );
		$( 'collapseButton' ).setAttribute( 'aria-expanded', String( ! collapsed ) );
		$( 'collapseButton' ).textContent = collapsed ? '설정 펼치기 ▾' : '설정 접기 ▴';

	};

	$( 'collapseButton' ).addEventListener( 'click', () => {

		collapsed = ! collapsed;
		applyCollapse();
		try {

			localStorage.setItem( 'settingsCollapsed', collapsed ? '1' : '0' );

		} catch ( e ) { /* 무시 */ }

	} );

	applyCollapse();

}

function setCameraMode( mode ) {

	if ( mode === 'people' && director.mode === 'people' ) {

		director.nextSubject();
		return;

	}

	director.setMode( mode, { me } );
	me.head.visible = mode !== 'first';
	camera.fov = 55;
	camera.updateProjectionMatrix();

	if ( mode === 'third' ) {

		controls.enabled = true;
		snapCamera();

	} else {

		controls.enabled = false;

	}

	refreshCameraButtons();

}

function refreshCameraButtons() {

	for ( const b of $( 'cameraModes' ).children ) b.classList.toggle( 'on', b.dataset.mode === director.mode );

}

// 페라리 타기 / 내리기
function toggleCar() {

	if ( traffic.player ) {

		const car = traffic.exit();
		traffic.doorSide( car, me.position );
		me.velocity.set( 0, 0, 0 );
		me.yaw = Math.atan2( car.heading.x, car.heading.z );
		me.setState( 'ground' );
		me.group.visible = true;
		me.shadow.visible = true;
		controls.minDistance = 1.8;

	} else if ( nearCar && me.state === 'ground' ) {

		const car = traffic.enter( nearCar );
		me.group.visible = false;
		me.shadow.visible = false;
		controls.minDistance = 5;

		// 차 뒤 조금 위에서 따라간다
		followTarget.copy( car.pos ).setY( car.pos.y + 0.7 );
		controls.target.copy( followTarget );
		cameraFree.copy( car.pos ).addScaledVector( car.heading, - 8 ).setY( car.pos.y + 3 );

	}

}

function toggleDance() {

	if ( traffic.player || me.state !== 'ground' ) return;
	me.dancing = ! me.dancing;

}

// 녹화 모드: 설정·글자를 모두 숨기고 시뮬레이션 화면만 (카메라 시점은 그대로)
function setRecording( on ) {

	recording = on;
	document.body.classList.toggle( 'recording', on );
	if ( on && document.activeElement ) document.activeElement.blur();

}

function setDroneSpeed( v ) {

	director.drone.speed = THREE.MathUtils.clamp( v, 2, 60 );
	$( 'droneSpeed' ).value = director.drone.speed;
	$( 'droneSpeedValue' ).textContent = `${ Math.round( director.drone.speed ) } m/s`;

}

// 나만 처음 자리로 (R)
function returnHome() {

	if ( traffic.player ) toggleCar();
	me.dancing = false;
	me.position.copy( SPAWN );
	me.velocity.set( 0, 0, 0 );
	me.yaw = Math.PI;
	me.setState( 'ground' );
	controls.maxDistance = 80;
	snapCamera();

}

// 시뮬레이션 전체 초기화: 빌딩·나무·간판 복구, 차와 사람 다시 배치, 설정값도 처음으로
function resetSimulation() {

	returnHome();
	fart.reset();
	fartHeld = false;
	$( 'fartButton' ).classList.remove( 'on' );
	destruction.reset();
	signs.restore();
	traffic.reset();
	people.reset( SPAWN );
	launchedTotal = 0;
	destroyedTotal = 0;
	maxAltitude = 0;

	$( 'diameter' ).value = 28;
	$( 'diameter' ).dispatchEvent( new Event( 'input' ) );
	$( 'time' ).value = 17.4;
	$( 'time' ).dispatchEvent( new Event( 'input' ) );
	setCameraMode( 'third' );

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

		if ( e.code === 'KeyE' && ! e.repeat && director.mode !== 'drone' ) toggleCar();
		if ( e.code === 'KeyC' && ! e.repeat ) {

			const i = CAMERA_MODES.findIndex( ( m ) => m.id === director.mode );
			setCameraMode( CAMERA_MODES[ ( i + 1 ) % CAMERA_MODES.length ].id );

		}

		if ( e.code === 'Enter' && recording ) {

			e.preventDefault();
			setRecording( false );

		}

		if ( e.code === 'KeyG' && ! e.repeat ) toggleDance();
		if ( e.code === 'BracketLeft' ) setDroneSpeed( director.drone.speed / 1.25 );
		if ( e.code === 'BracketRight' ) setDroneSpeed( director.drone.speed * 1.25 );

		const digit = /^Digit([1-7])$/.exec( e.code );
		if ( digit && ! e.repeat ) setCameraMode( CAMERA_MODES[ digit[ 1 ] - 1 ].id );
		if ( e.code === 'Tab' ) {

			e.preventDefault();
			if ( director.mode === 'people' ) director.nextSubject();

		}

		if ( e.code === 'KeyR' && ! e.repeat ) returnHome();

		if ( [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].includes( e.code ) ) e.preventDefault();
		// 드론에서 Ctrl 은 아래로 (Ctrl+S 저장, Ctrl+D 북마크 같은 브라우저 단축키를 막는다)
		if ( director.mode === 'drone' && e.ctrlKey && [ 'KeyS', 'KeyD', 'KeyA' ].includes( e.code ) ) e.preventDefault();

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

	// 드론 시점: WASD·Shift·Ctrl 는 드론, 방향키는 나 (찍으면서 걷고 방구도 뀔 수 있다)
	if ( director.mode === 'drone' ) {

		droneInput.forward = clamp( ( keys.KeyW ? 1 : 0 ) - ( keys.KeyS ? 1 : 0 ) - stick.y );
		droneInput.right = clamp( ( keys.KeyD ? 1 : 0 ) - ( keys.KeyA ? 1 : 0 ) + stick.x );
		droneInput.up = ( keys.ShiftLeft || keys.ShiftRight ? 1 : 0 ) - ( keys.ControlLeft || keys.ControlRight ? 1 : 0 );

		const mf = ( keys.ArrowUp ? 1 : 0 ) - ( keys.ArrowDown ? 1 : 0 );
		const mr = ( keys.ArrowRight ? 1 : 0 ) - ( keys.ArrowLeft ? 1 : 0 );
		const yaw = director.drone.yaw;
		const forward = new THREE.Vector3( Math.sin( yaw ), 0, Math.cos( yaw ) );
		const right = new THREE.Vector3( - Math.cos( yaw ), 0, Math.sin( yaw ) );
		return { move: forward.multiplyScalar( mf ).addScaledVector( right, mr ), run: false, forward: mf, turn: mr };

	}

	// 카메라 기준 이동 방향 (컷이 바뀌는 연출 시점에서는 마지막으로 직접 잡던 카메라 방향)
	const forward = new THREE.Vector3();

	if ( director.mode === 'third' || director.mode === 'first' ) {

		camera.getWorldDirection( forward );
		forward.y = 0;
		forward.normalize();
		controlYaw = Math.atan2( forward.x, forward.z );

	} else {

		forward.set( Math.sin( controlYaw ), 0, Math.cos( controlYaw ) );

	}
	const right = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) );
	const move = forward.multiplyScalar( f ).addScaledVector( right, r );

	// 조이스틱을 끝까지 밀면 달리기
	return { move, run: keys.ShiftLeft || keys.ShiftRight || Math.hypot( stick.x, stick.y ) > 0.9, forward: f, turn: r };

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

	const driving = traffic.player !== null && traffic.player !== undefined;
	directorEvents.length = 0;

	fart.update( dt, fartHeld, me, nightness.value, camera );
	if ( driving ) traffic.drive( dt, input, fart, me );
	else me.update( dt, input, world, fart );
	traffic.update( dt, me, fart );
	people.update( dt, me, fart, camera );

	// 충분히 센 방구는 가벼운 것(사람·나무·길가 물건)부터 날리고, 이륙선을 넘어야 빌딩까지 날린다
	const light = fart.physics.force >= LIGHT_LAUNCH_FORCE;
	const strong = fart.physics.force >= LIFTOFF_FORCE;
	if ( fart.active && light ) destruction.blast( dt, me.jetOrigin, fart.physics, strong );
	destruction.update( dt );

	for ( const e of destruction.events ) {

		if ( e.type === 'destroy' ) {

			destroyedTotal += e.towers;
			directorEvents.push( 'destroy' );

		}

	}

	destruction.events.length = 0;

	// 페라리 근처면 탈 수 있다
	nearCar = driving || director.mode === 'drone' ? null : traffic.nearestCar( me.position );
	$( 'carButton' ).hidden = ! ( nearCar || driving );
	$( 'carButton' ).textContent = driving ? '🚶 내리기 (E)' : '🏎️ 타기 (E)';

	// 내가 모는 차에 치여도 날아간다
	if ( driving ) people.hit( traffic.player.pos, _carVel.copy( traffic.player.heading ).multiplyScalar( traffic.player.speed ), 2.4 );

	// 달리는 차에 치인 사람은 날아간다
	for ( const car of traffic.cars ) {

		if ( car.mode === 'lane' || car.mode === 'turn' ) people.hit( car.pos, _carVel.copy( car.heading ).multiplyScalar( car.speed ) );
		else if ( car.mode === 'fly' ) people.hit( car.pos, car.vel, 2.6 );

	}

	// 방구 이벤트
	for ( const e of fart.events ) {

		if ( e.type === 'shock' ) {

			traffic.shock( me.position, e.force, e.radius );
			people.shock( me.position, e.force, e.radius );
			if ( light ) destruction.shock( me.position, e.force, e.radius, strong );
			directorEvents.push( 'shock' );

		}

	}

	fart.events.length = 0;

	for ( const e of traffic.events ) {

		if ( e.type === 'launch' ) {

			launchedTotal += e.count;
			directorEvents.push( 'launch' );

		}

	}

	traffic.events.length = 0;
	$( 'counter' ).textContent = `페라리 ${ launchedTotal }대 · 빌딩 ${ destroyedTotal }채`;

	// 상태 변화
	if ( me.state !== lastState ) {

		if ( me.state === 'air' && fart.active ) directorEvents.push( 'liftoff' );
		if ( lastState === 'air' ) sound.thud( Math.min( 1, ( me.lastImpact || 0 ) / 10 ) );
		lastState = me.state;

	}

	// 비행 정보
	const altitude = Math.max( 0, me.position.y - world.heightAt( me.position.x, me.position.z ) );
	const flying = me.state === 'air' && ! driving;
	$( 'flight' ).hidden = ! flying && ! driving;

	if ( flying || driving ) {

		maxAltitude = Math.max( maxAltitude, me.position.y );
		$( 'altitude' ).textContent = me.position.y.toFixed( 0 );
		$( 'speed' ).textContent = ( ( driving ? Math.abs( traffic.player.speed ) : me.velocity.length() ) * 3.6 ).toFixed( 0 );

	}

	$( 'tankBar' ).style.width = `${ fart.tank * 100 }%`;
	$( 'tankText' ).textContent = `${ Math.round( fart.tank * 100 ) }%`;
	$( 'panel' ).classList.toggle( 'empty', fart.tank < 0.02 );
	$( 'danceButton' ).classList.toggle( 'on', me.dancing );

	// 카메라: 나를 따라가고, 벽에 막히면 당겨지고, 방구 세기만큼 흔들린다
	const target = me.position.clone().add( new THREE.Vector3( 0, me.state === 'down' ? 0.4 : ( driving ? 1.2 : 1.3 ), 0 ) );
	const delta = target.clone().sub( followTarget ).multiplyScalar( Math.min( 1, dt * ( flying || driving ? 6 : 10 ) ) );
	followTarget.add( delta );

	// 카메라 연출에서 오류가 나도 화면이 멈추지 않게 3인칭으로 돌아간다
	let directed = false;

	try {

		directed = director.mode !== 'third' && director.update( { dt, me, people, traffic, fart, driving, events: directorEvents, drone: droneInput } );

	} catch ( error ) {

		console.error( error );
		setCameraMode( 'third' );

	}

	if ( directed ) {

		// 3인칭으로 돌아올 때를 위해 따라가기만 한다
		cameraFree.add( delta );
		controls.target.copy( followTarget );

	} else {

		camera.position.copy( cameraFree );
		camera.position.add( delta );
		controls.target.copy( followTarget );
		if ( flying && altitude > 8 ) controls.maxDistance = 120;
		controls.update();
		cameraFree.copy( camera.position );
		keepCameraOutside();

	}

	document.body.classList.toggle( 'cinema', director.mode === 'auto' );

	const s = director.mode === 'drone' ? 0 : fart.shake;
	camera.position.add( new THREE.Vector3( ( Math.random() - 0.5 ) * s, ( Math.random() - 0.5 ) * s, ( Math.random() - 0.5 ) * s ) );

	// 확인용 고정 카메라
	if ( window.__freeCam ) {

		camera.position.copy( window.__freeCam.pos );
		camera.lookAt( window.__freeCam.target );

	}

	renderPipeline.render();

	// 셰이더가 다 만들어질 때까지 (처음 2초 남짓은 화면이 검게 나올 수 있다) 로딩 화면을 덮어 둔다
	window.__frames = frameCount + 1;
	if ( ++ frameCount === 1 ) firstFrameTime = performance.now();
	if ( ! loadingDone && frameCount > 3 && performance.now() - firstFrameTime > 2500 ) {

		loadingDone = true;
		$( 'loading' ).classList.add( 'done' );

	}

}
