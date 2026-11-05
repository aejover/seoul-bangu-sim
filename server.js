// 의존성 없는 정적 파일 서버: node server.js [port]
const http = require( 'http' );
const fs = require( 'fs' );
const path = require( 'path' );

const root = __dirname;
const port = parseInt( process.argv[ 2 ] || process.env.PORT || '5173' );

const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.glb': 'model/gltf-binary',
	'.woff': 'font/woff',
	'.obj': 'text/plain'
};

http.createServer( ( req, res ) => {

	const url = decodeURIComponent( req.url.split( '?' )[ 0 ] );
	let file = path.normalize( path.join( root, url === '/' ? 'index.html' : url ) );

	if ( ! file.startsWith( root ) ) {

		res.writeHead( 403 ).end();
		return;

	}

	fs.readFile( file, ( err, data ) => {

		if ( err ) {

			res.writeHead( 404 ).end( 'not found' );
			return;

		}

		res.writeHead( 200, { 'Content-Type': types[ path.extname( file ).toLowerCase() ] || 'application/octet-stream', 'Cache-Control': 'no-store' } );
		res.end( data );

	} );

} ).listen( port, () => console.log( `http://localhost:${ port }` ) );
