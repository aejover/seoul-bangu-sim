// 도시 격자 정보: 땅 높이, 건물 충돌, 도로망
// CityGenerator 레이아웃 기준으로 차도 중심선은 x = i * periodX, z = j * periodZ 에 놓인다

const mod = ( a, n ) => ( ( a % n ) + n ) % n;

export class World {

	constructor( city, tiles ) {

		const L = city.layout;

		this.layout = L;
		this.curb = city.parameters.curbHeight;
		this.street = L.street;
		this.periodX = L.blockW + L.street;
		this.periodZ = L.blockD + L.street;
		this.spanX = L.cityW + L.street;
		this.spanZ = L.cityD + L.street;
		this.tiles = tiles;

		this.blockLimitX = tiles * this.spanX / 2 - L.street / 2;
		this.blockLimitZ = tiles * this.spanZ / 2 - L.street / 2;

		// 모든 타일의 건물 상자 (월드 좌표)
		this.towers = [];
		this.cell = 16;
		this.grid = new Map();

		for ( let x = 0; x < tiles; x ++ ) {

			for ( let z = 0; z < tiles; z ++ ) {

				const ox = ( x - ( tiles - 1 ) / 2 ) * this.spanX;
				const oz = ( z - ( tiles - 1 ) / 2 ) * this.spanZ;

				for ( const t of city.towers ) {

					const box = {
						x0: ox + t.x - t.w / 2, x1: ox + t.x + t.w / 2,
						z0: oz + t.z - t.d / 2, z1: oz + t.z + t.d / 2,
						cx: ox + t.x, cz: oz + t.z, w: t.w, d: t.d,
						top: t.y + t.h / 2
					};

					this.towers.push( box );

					const c = this.cell;
					for ( let gx = Math.floor( box.x0 / c ); gx <= Math.floor( box.x1 / c ); gx ++ ) {

						for ( let gz = Math.floor( box.z0 / c ); gz <= Math.floor( box.z1 / c ); gz ++ ) {

							const key = gx + ',' + gz;
							if ( ! this.grid.has( key ) ) this.grid.set( key, [] );
							this.grid.get( key ).push( box );

						}

					}

				}

			}

		}

	}

	// 블록(인도+건물 부지) 위인가
	isBlock( x, z ) {

		if ( Math.abs( x ) > this.blockLimitX || Math.abs( z ) > this.blockLimitZ ) return false;
		return mod( x + this.street / 2, this.periodX ) >= this.street && mod( z + this.street / 2, this.periodZ ) >= this.street;

	}

	towerAt( x, z ) {

		const list = this.grid.get( Math.floor( x / this.cell ) + ',' + Math.floor( z / this.cell ) );
		if ( ! list ) return null;
		let best = null;

		for ( const b of list ) {

			if ( ! b.gone && x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && ( best === null || b.top > best.top ) ) best = b;

		}

		return best;

	}

	heightAt( x, z ) {

		const tower = this.towerAt( x, z );
		if ( tower ) return tower.top;
		return this.isBlock( x, z ) ? this.curb : 0;

	}

	// 가장 가까운 차도 중심선
	nearestStreetX( x ) {

		return Math.round( x / this.periodX ) * this.periodX;

	}

	nearestStreetZ( z ) {

		return Math.round( z / this.periodZ ) * this.periodZ;

	}

}
