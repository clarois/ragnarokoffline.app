'use strict';
// The game's .bmp icons and pictures as PNGs with real transparency.
//
// Ragnarok's interface bitmaps mark "transparent" with magenta (255, 0, 255),
// which a browser draws as magenta. The Tools windows get their images
// through this, so an icon sits on the page the way it sits in the game.
// Hand-rolled like the rest of the app: a BMP reader for the uncompressed
// 8, 24 and 32-bit files the client uses, and a PNG writer on node's zlib.

const zlib = require('node:zlib');

// Close to magenta counts too: the bitmaps were saved with a little drift.
const isMagenta = (r, g, b) => r >= 250 && g <= 8 && b >= 250;

/** RGBA pixels from a BMP, or null if it is a kind this does not read. */
function decodeBmp(buf) {
	if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
	const offset = buf.readUInt32LE(10);
	const headerSize = buf.readUInt32LE(14);
	const width = buf.readInt32LE(18);
	let height = buf.readInt32LE(22);
	const bpp = buf.readUInt16LE(28);
	const compression = buf.readUInt32LE(30);
	if (width <= 0 || width > 4096 || height === 0 || Math.abs(height) > 4096) return null;
	if (compression !== 0 && !(compression === 3 && bpp === 32)) return null;
	const topDown = height < 0;
	height = Math.abs(height);
	let palette = null;
	if (bpp === 8) {
		const colors = buf.readUInt32LE(46) || 256;
		palette = buf.subarray(14 + headerSize, 14 + headerSize + colors * 4);
	} else if (bpp !== 24 && bpp !== 32) {
		return null;
	}
	const stride = Math.ceil((width * bpp) / 32) * 4;
	if (offset + stride * height > buf.length) return null;
	const out = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = offset + (topDown ? y : height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			let r, g, b;
			if (bpp === 8) {
				const i = buf[row + x] * 4;
				b = palette[i]; g = palette[i + 1]; r = palette[i + 2];
			} else {
				const p = row + x * (bpp / 8);
				b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
			}
			const o = (y * width + x) * 4;
			if (isMagenta(r, g, b)) continue; // left fully transparent
			out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
		}
	}
	return { width, height, rgba: out };
}

let crcTable = null;
function crc32(data) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function encodePng({ width, height, rgba }) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // no filter
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** A PNG with magenta made transparent, or null to serve the original. */
function bmpToPng(buf) {
	const image = decodeBmp(buf);
	return image ? encodePng(image) : null;
}

module.exports = { bmpToPng, decodeBmp, encodePng };
