const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const media = resolve(__dirname, '../media');
const renderer = new Resvg(readFileSync(resolve(media, 'logo.svg')), { fitTo: { mode: 'width', value: 256 } });
writeFileSync(resolve(media, 'logo.png'), renderer.render().asPng());
