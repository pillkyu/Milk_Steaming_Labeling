import {extractSegments} from './audio-features.mjs';
import {assess} from './feedback.mjs';
self.onmessage=({data})=>{
 try{const vectors=data.vectors||extractSegments(data.pcm,data.segments,p=>self.postMessage({progress:p}));self.postMessage({checks:assess(vectors,data.rows)});}
 catch(e){self.postMessage({error:e.message});}
};
