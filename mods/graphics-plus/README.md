# graphics-plus

A warmer, deeper look for every map, in one pass over the screen:

| Setting | What it does |
|---|---|
| Colour grading | warm light, cool shadows, a little contrast |
| Lamp glow | a soft halo at each light the map places (lamps, torches, braziers) |
| Water reflections | water mirrors the buildings, rocks and sky above it (draws the map twice where there's water) |
| Grass | tufts on grassy ground, coloured by the ground under them, swaying |
| Shadows | buildings and trees cast shadows from the map's sun onto the ground |
| Distance haze | far things fade into the map's own light colour (needs WebGL 2) |
| Tone mapping | bright areas roll off instead of clipping, which matters with bloom |
| Vignette | darker corners |
| Tilt-shift blur | a miniature-photograph blur at the top and bottom |
| Colour fringing | a slight lens-like colour split toward the edges |
| Rain | rain over everything |

Each is a number from 0 (off) to 100 under **Settings → Mods → graphics-plus**.
The mod is off until you switch it on.

It is also the worked example of `api.graphics.registerPass`: everything is
the GLSL in [`client/index.js`](client/index.js). The pass is handed the frame,
its depth, the map's sun and its point lights already projected onto the
screen. See docs/MODDING.md, "Graphics passes".

Water reflections, grass and shadows are renderer features rather than part
of the pass: `api.graphics.configure({ waterReflection, grass, shadows })`.
