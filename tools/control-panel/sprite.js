'use strict';
// A player character, drawn the way the game draws one standing still and
// facing south: garment, body, head, then the middle, top and lower headgear,
// each sprite with its palette (#230).
//
// The paths are roBrowser's (DB/DBManager.js: getBodyPath, getBodyPalPath,
// getHeadPath, getHeadPalPath, getHatPath, getRobePath) and the layering is
// its EntityRender.js for a PC looking front: the body is the main sprite and
// every head-bound sprite is placed by the difference between the body's
// anchor point and its own. The sprite-name tables come from the client
// (look-tables.json); the files from the asset server, through the app.
//
// The .spr/.act reading is the monster browser's (tools/mob-browser), plus
// the anchor points it does not need. That page keeps its own copy because it
// is written to work from a folder on its own.
//
// Not drawn: weapons, shields, mounts, carts, and the hairstyle a costume
// replaces. They need tables the client builds at run time.

(function () {
	const SEX = ['여', '남']; // female, male: what the GRF's folders are called

	function reader(buf) {
		const dv = new DataView(buf);
		let p = 0;
		return {
			get pos() { return p; }, set pos(v) { p = v; },
			u8: () => dv.getUint8(p++),
			u16: () => { const v = dv.getUint16(p, true); p += 2; return v; },
			i16: () => { const v = dv.getInt16(p, true); p += 2; return v; },
			i32: () => { const v = dv.getInt32(p, true); p += 4; return v; },
			u32: () => { const v = dv.getUint32(p, true); p += 4; return v; },
			f32: () => { const v = dv.getFloat32(p, true); p += 4; return v; },
			str: n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + i)); p += n; return s; },
		};
	}

	function readSpr(buf) {
		const r = reader(buf);
		if (r.str(2) !== 'SP') throw new Error('not a sprite');
		const version = r.u8() / 10 + r.u8();
		const indexed = r.u16();
		const rgba = version > 1.1 ? r.u16() : 0;
		const frames = [];
		for (let i = 0; i < indexed; i++) {
			const w = r.u16(), h = r.u16();
			const data = new Uint8Array(w * h);
			if (version < 2.1) {
				for (let j = 0; j < w * h; j++) data[j] = r.u8();
			} else {
				// Runs of transparent pixels are stored as 0, count.
				const end = r.u16() + r.pos;
				let k = 0;
				while (r.pos < end) {
					const c = r.u8();
					data[k++] = c;
					if (!c) {
						const n = r.u8();
						if (!n) data[k++] = 0; else for (let j = 1; j < n; j++) data[k++] = 0;
					}
				}
			}
			frames.push({ rgba: false, w, h, data });
		}
		for (let i = 0; i < rgba; i++) {
			const w = r.i16(), h = r.i16();
			const data = new Uint8Array(buf, r.pos, w * h * 4).slice();
			r.pos += w * h * 4;
			frames.push({ rgba: true, w, h, data });
		}
		const palette = version > 1.0 ? new Uint8Array(buf, buf.byteLength - 1024, 1024) : null;
		return { indexed, frames, palette };
	}

	// Each frame: its layers, and its anchor points (where a head goes on a
	// body, and where a head is held from).
	function readAct(buf) {
		const r = reader(buf);
		if (r.str(2) !== 'AC') throw new Error('not an action file');
		const version = r.u8() / 10 + r.u8();
		const count = r.u16();
		r.pos += 10;
		const actions = [];
		for (let a = 0; a < count; a++) {
			const frames = [];
			const nf = r.u32();
			for (let f = 0; f < nf; f++) {
				r.pos += 32;
				const nl = r.u32();
				const layers = [];
				for (let l = 0; l < nl; l++) {
					const layer = { x: r.i32(), y: r.i32(), index: r.i32(), mirror: r.i32(), alpha: 1, sx: 1, sy: 1, angle: 0, type: 0 };
					if (version >= 2.0) {
						r.u8(); r.u8(); r.u8(); layer.alpha = r.u8() / 255;
						layer.sx = r.f32();
						layer.sy = version <= 2.3 ? layer.sx : r.f32();
						layer.angle = r.i32();
						layer.type = r.i32();
						if (version >= 2.5) { r.i32(); r.i32(); }
					}
					layers.push(layer);
				}
				if (version >= 2.0) r.i32(); // sound
				const anchors = [];
				if (version >= 2.3) {
					const np = r.i32();
					for (let i = 0; i < np; i++) { r.i32(); anchors.push({ x: r.i32(), y: r.i32() }); r.i32(); }
				}
				frames.push({ layers, anchors });
			}
			actions.push(frames);
		}
		return { actions };
	}

	// One canvas per sprite frame, coloured with `pal` (a .pal file, or the
	// sprite's own palette).
	function frameImages(spr, pal) {
		const palette = pal || spr.palette;
		return spr.frames.map(f => {
			const c = document.createElement('canvas');
			c.width = Math.max(1, f.w); c.height = Math.max(1, f.h);
			const ctx = c.getContext('2d');
			const img = ctx.createImageData(c.width, c.height);
			const out = img.data;
			for (let y = 0; y < f.h; y++) {
				for (let x = 0; x < f.w; x++) {
					const o = (y * f.w + x) * 4;
					if (f.rgba) {
						// Stored bottom-up, as A, B, G, R.
						const s = ((f.h - y - 1) * f.w + x) * 4;
						out[o] = f.data[s + 3]; out[o + 1] = f.data[s + 2]; out[o + 2] = f.data[s + 1]; out[o + 3] = f.data[s];
					} else {
						const i = f.data[y * f.w + x];
						if (!i || !palette) continue;
						out[o] = palette[i * 4]; out[o + 1] = palette[i * 4 + 1]; out[o + 2] = palette[i * 4 + 2]; out[o + 3] = 255;
					}
				}
			}
			ctx.putImageData(img, 0, 0);
			return c;
		});
	}

	const isDoram = job => (job >= 4217 && job <= 4220) || job === 4308 || job === 4315;

	/**
	 * The files a character is drawn from, in drawing order, as
	 * { part, spr, pal, main } with paths relative to the client's data root.
	 * `t` is look-tables.json.
	 */
	function parts(look, t) {
		const job = Number(look.class), sexIndex = look.sex === 'M' ? 1 : 0, sex = SEX[sexIndex];
		const race = isDoram(job) ? '도람족' : '인간족';
		const out = [];
		const className = id => t.classes[id] || t.classes[0];
		// getBodyPath: an outfit (`body`) other than the job draws that job's
		// sprite, from costume_1/ for the costume jobs.
		let bodyName = `${className(job)}_${sex}`;
		const outfit = Number(look.body);
		if (outfit > 0 && outfit !== job && t.classes[outfit]) {
			const costume = outfit > t.costume[0] && outfit < t.costume[1];
			bodyName = `${costume ? 'costume_1/' : ''}${className(outfit)}_${sex}${costume ? '_1' : ''}`;
		}
		const robe = Number(look.robe);
		if (robe > 0 && t.robes[robe]) {
			out.push({
				part: 'garment', main: true,
				spr: `data/sprite/로브/${t.robes[robe]}/${sex}/${className(job)}_${sex}`,
				fallback: `data/sprite/로브/${t.robes[robe]}/${t.robes[robe]}${isDoram(job) ? '_doram' : ''}`,
			});
		}
		const clothes = Number(look.clothes_color);
		out.push({
			part: 'body', main: true,
			spr: `data/sprite/${race}/몸통/${sex}/${bodyName}`,
			pal: clothes > 0 && t.palettes[job] ? `data/palette/몸/${t.palettes[job]}_${sex}_${clothes}.pal` : null,
		});
		const hair = Number(look.hair);
		const order = (t.hair[sexIndex + (isDoram(job) ? 2 : 0)] || [])[hair] || hair;
		const hairColor = Number(look.hair_color);
		out.push({
			part: 'head',
			spr: `data/sprite/${race}/머리통/${sex}/${order}_${sex}`,
			pal: hairColor > 0
				? (job === 4218 || job === 4220
					? `data/palette/도람족/머리/머리${order}_${sex}_${hairColor}.pal`
					: `data/palette/머리/머리${order}_${sex}_${hairColor}.pal`)
				: null,
		});
		// Middle, top, lower: the game skips a slot that repeats one drawn.
		const top = Number(look.head_top), mid = Number(look.head_mid), low = Number(look.head_bottom);
		const hat = (part, id) => { if (id > 0 && t.hats[id]) out.push({ part, spr: `data/sprite/악세사리/${sex}/${sex}${t.hats[id]}` }); };
		if (mid !== low) hat('middle headgear', mid);
		if (top !== low && top !== mid) hat('top headgear', top);
		hat('lower headgear', low);
		return out;
	}

	async function fetchBytes(rel) {
		const res = await fetch('asset/' + rel.split('/').map(encodeURIComponent).join('/'));
		if (!res.ok) throw new Error(`missing ${rel}`);
		return res.arrayBuffer();
	}

	async function load(p) {
		let spr, act;
		try {
			[spr, act] = await Promise.all([fetchBytes(p.spr + '.spr'), fetchBytes(p.spr + '.act')]);
		} catch (e) {
			if (!p.fallback) throw e;
			[spr, act] = await Promise.all([fetchBytes(p.fallback + '.spr'), fetchBytes(p.fallback + '.act')]);
		}
		// A palette that is not there leaves the sprite's own colours, as in game.
		const pal = p.pal ? await fetchBytes(p.pal).then(b => new Uint8Array(b, 0, 1024)).catch(() => null) : null;
		const sprite = readSpr(spr);
		return { ...p, sprite, act: readAct(act), images: frameImages(sprite, pal) };
	}

	/**
	 * Draw `look` (a character row) on `canvas`. Resolves with the parts that
	 * could not be drawn, so the page can say which.
	 */
	async function draw(canvas, look, tables) {
		const wanted = parts(look, tables);
		const loaded = await Promise.allSettled(wanted.map(load));
		const missing = wanted.filter((_, i) => loaded[i].status !== 'fulfilled').map(p => p.part);
		const ready = loaded.filter(l => l.status === 'fulfilled').map(l => l.value);
		// Standing (action 0), facing south (direction 0), head straight (frame 0).
		const frameOf = l => (l.act.actions[0] || [])[0] || { layers: [], anchors: [] };
		const body = ready.find(l => l.part === 'body');
		const anchor = body && frameOf(body).anchors[0];
		const placed = [];
		for (const l of ready) {
			const frame = frameOf(l);
			let dx = 0, dy = 0;
			if (!l.main && anchor && frame.anchors[0]) { dx = anchor.x - frame.anchors[0].x; dy = anchor.y - frame.anchors[0].y; }
			for (const layer of frame.layers) {
				if (layer.index < 0) continue;
				const img = l.images[layer.index + (layer.type === 1 ? l.sprite.indexed : 0)];
				if (img) placed.push({ img, layer, x: layer.x + dx, y: layer.y + dy });
			}
		}
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (!placed.length) return missing.length ? missing : ['body'];
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const p of placed) {
			const w = p.img.width * Math.abs(p.layer.sx), h = p.img.height * Math.abs(p.layer.sy);
			x0 = Math.min(x0, p.x - w / 2); x1 = Math.max(x1, p.x + w / 2);
			y0 = Math.min(y0, p.y - h / 2); y1 = Math.max(y1, p.y + h / 2);
		}
		const margin = 12;
		// Half steps rather than whole ones: a sprite a few pixels too tall for
		// 2x would otherwise drop to 1x and sit small in the middle of the box.
		const fit = Math.min((canvas.width - margin) / (x1 - x0), (canvas.height - margin) / (y1 - y0));
		const zoom = Math.max(1, Math.min(3, Math.floor(fit * 2) / 2));
		const cx = canvas.width / 2 - ((x0 + x1) / 2) * zoom, cy = canvas.height / 2 - ((y0 + y1) / 2) * zoom;
		ctx.imageSmoothingEnabled = false;
		for (const p of placed) {
			ctx.save();
			ctx.globalAlpha = p.layer.alpha;
			ctx.translate(Math.round(cx + p.x * zoom), Math.round(cy + p.y * zoom));
			if (p.layer.angle) ctx.rotate(p.layer.angle * Math.PI / 180);
			ctx.scale(p.layer.sx * zoom * (p.layer.mirror ? -1 : 1), p.layer.sy * zoom);
			ctx.drawImage(p.img, -p.img.width / 2, -p.img.height / 2);
			ctx.restore();
		}
		return missing;
	}

	window.PlayerSprite = { draw, parts, readSpr, readAct };
})();
