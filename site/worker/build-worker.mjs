import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dist=resolve(root,"dist");
const target=resolve(dist,"server","index.js");
const types={
  ".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".webp":"image/webp",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".ico":"image/x-icon",".woff2":"font/woff2",".mp4":"video/mp4",".webm":"video/webm",".txt":"text/plain; charset=utf-8"
};
const assets={};
async function walk(directory) {
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=resolve(directory,entry.name);
    if(entry.name.startsWith(".")||path===dirname(target)||path===resolve(dist,"news.json")) continue;
    if(entry.isDirectory()) await walk(path);
    else if(entry.isFile() && Object.hasOwn(types,extname(entry.name))) {
      const bytes=await readFile(path);
      assets["/"+relative(dist,path)]={type:types[extname(entry.name)],base64:bytes.toString("base64"),size:bytes.byteLength};
    }
  }
}
await walk(dist);
if(!assets["/index.html"]) throw Error("dist/index.html is required before building.");
const seed=JSON.parse(await readFile(resolve(dist,"news.json"),"utf8"));
if(!Array.isArray(seed)) throw Error("dist/news.json must be a JSON array.");
const runtime=await readFile(resolve(root,"worker","runtime.mjs"),"utf8");
const bundle=runtime + "\nexport default makeApp(" + JSON.stringify(assets) + "," + JSON.stringify(seed) + ");\n";
const compressed=gzipSync(bundle).byteLength;
if(compressed>3_050_000) throw Error(`Worker compressed size ${compressed} bytes; optimize/remove unreferenced media to remain below 3 MB.`);
await mkdir(dirname(target),{recursive:true});
await writeFile(target+".tmp",bundle);
await rename(target+".tmp",target);
console.log(JSON.stringify({worker:"dist/server/index.js",assets:Object.keys(assets),seedRecords:seed.length,compressedBytes:compressed}));
