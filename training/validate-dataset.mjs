import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {validateRecord,sha256} from '../site/records.mjs';
const root=path.resolve(process.argv[2]),schema=JSON.parse(await readFile(new URL('../site/labels.json',import.meta.url)));
let count=0;
for(const id of (await readdir(path.join(root,'recordings'))).sort()){
 if(!/^[a-f0-9]{64}$/.test(id))throw Error('Unexpected recording directory');
 const record=validateRecord(JSON.parse(await readFile(path.join(root,'recordings',id,'record.json'))),schema);
 if(record.source.id!==id)throw Error('Directory / source ID mismatch');
 const audio=await readFile(path.join(root,record.source.originalAudio));
 if(audio.length!==record.source.bytes||await sha256(audio)!==id)throw Error('Original audio hash mismatch');
 count++;
}
console.log(`Validated ${count} original recordings and annotations`);
