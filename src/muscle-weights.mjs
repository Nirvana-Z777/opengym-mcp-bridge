// Independent adapter for openGym's published muscle vocabulary and effective-set contract.
// No official implementation or exercise dataset is shipped with this module.
import { MUSCLES } from './custom-exercises.mjs';
import { exerciseMetadata } from './workout-data.mjs';
import { isObject } from './validate.mjs';

const aliases=new Map();
for(const [slug,words] of Object.entries({
 chest:'pectorals|upper chest', 'upper-back':'upper back|lats|back|rhomboids|latissimus dorsi',
 deltoids:'delts|shoulders|rear deltoids|rotator cuff', biceps:'brachialis', forearm:'forearms|wrists|wrist flexors|wrist extensors|grip muscles',
 abs:'core|abdominals|lower abs', 'lower-back':'spine|lower back', gluteal:'glutes|abductors', quadriceps:'quads',
 hamstring:'hamstrings', trapezius:'traps|levator scapulae', serratus:'serratus anterior', adductors:'groin|inner thighs',
 'hip-flexors':'hip flexors', calves:'soleus', tibialis:'shins',
}))for(const word of words.split('|'))aliases.set(word,slug);
const canonical=value=>{if(typeof value!=='string')return null;const key=value.trim().toLowerCase();return MUSCLES.includes(key)?key:aliases.get(key)||null;};
const splitMuscles=['front-delts','side-delts','rear-delts','lats'];
const modernAliases=new Map([
 ['front delts','front-delts'],['side delts','side-delts'],['rear delts','rear-delts'],
 ['rear deltoids','rear-delts'],['rotator cuff','rear-delts'],['latissimus dorsi','lats'],
]);
const slugOf=(meta,name)=>{
 if(meta.mv!==2||typeof name!=='string')return canonical(name);
 const key=name.trim().toLowerCase();
 return splitMuscles.includes(key)?key:modernAliases.get(key)??canonical(name);
};
function addWeight(out,meta,slug,weight){
 const parts=meta.mv===2&&slug==='deltoids'?[['front-delts',1],['side-delts',.6],['rear-delts',.4]]:[[slug,1]];
 for(const [key,factor] of parts)out[key]=Math.max(out[key]??0,factor===1?weight:Math.round(weight*factor*100)/100);
}
const array=v=>Array.isArray(v)?v:v==null||v===''?[]:[v];
const first=(m,keys)=>{for(const k of keys)if(Object.hasOwn(m,k))return m[k];return null;};
const fallback={chest:{chest:1},back:{'upper-back':.75,'lower-back':.25},shoulders:{deltoids:1},'upper arms':{biceps:.5,triceps:.5},
 'lower arms':{forearm:1},waist:{abs:.7,obliques:.3},'upper legs':{quadriceps:.4,hamstring:.35,gluteal:.25},
 'lower legs':{calves:.8,tibialis:.2},neck:{trapezius:1},'full body':{chest:.2,'upper-back':.2,gluteal:.2,quadriceps:.2,hamstring:.1,abs:.1}};

// A valid nonempty explicit map is authoritative as a whole, including all-zero maps.
// Malformed numeric values are not coerced into weights. Unknown muscle keys are ignored.
export function explicitMuscleWeights(meta){
 if(!isObject(meta?.muscleWeights))return null;
 const out={};
 for(const [key,value] of Object.entries(meta.muscleWeights)){
  if((!MUSCLES.includes(key)&&!(meta.mv===2&&splitMuscles.includes(key)))||key==='cardiovascular system')continue;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)return null;
  if(meta.mv===2&&key==='deltoids')addWeight(out,meta,key,value);
  else out[key]=Math.max(out[key]??0,value);
 }
 return Object.keys(out).length?out:null;
}
export function defaultMuscleWeights(meta){
 if(!isObject(meta))return {};
 const primary=array(first(meta,['primaries','primaryMuscles','primary']));
 const secondary=array(first(meta,['secondaries','secondaryMuscles','secondary']));
 const groups=first(meta,['muscleGroups','muscles','targetMuscles']);
 const pairs=primary.concat(secondary).some(name=>slugOf(meta,name))
  ? [...primary.map(x=>[x,1]),...secondary.map(x=>[x,.4])]
  : groups!=null&&array(groups).length?array(groups).map(x=>[x,1])
  : [[meta.tg,1],[meta.mg,.4],...array(meta.sm).map(x=>[x,.4])];
 const out={};
 for(const [name,weight] of pairs){const slug=slugOf(meta,name);if(slug)addWeight(out,meta,slug,weight);}
 const modernFallback={back:{lats:.4,'upper-back':.4,'lower-back':.2},shoulders:{'front-delts':.4,'side-delts':.4,'rear-delts':.2},
  'full body':{chest:.2,lats:.1,'upper-back':.1,gluteal:.2,quadriceps:.2,hamstring:.1,abs:.1}};
 return Object.keys(out).length?out:{...(meta.mv===2?modernFallback[meta.bp]??fallback[meta.bp]:fallback[meta.bp])};
}
export function weightsForEntry(state,catalogue,entry){
 const historical=[['snapshot',entry.muscleSnapshot],['entry',entry.exercise||entry]];
 for(const [source,meta] of historical){const weights=explicitMuscleWeights(meta);if(weights)return {weights,source:source+'_explicit'};}
 // Do not reinterpret snapshots made before the shoulder/lats split when the text
 // catalogue is refreshed. Invalid explicit maps keep the existing fallback behavior.
 const snapshot=entry.muscleSnapshot;
 if(catalogue.source_version==='1.4.5'&&isObject(snapshot)&&!Object.hasOwn(snapshot,'muscleWeights')){
  const weights=defaultMuscleWeights(snapshot);
  if(Object.keys(weights).length)return {weights,source:'snapshot_default'};
 }
 const current=exerciseMetadata(state,catalogue,entry.id);
 if(current){const explicit=explicitMuscleWeights(current),weights=explicit||defaultMuscleWeights(current);if(Object.keys(weights).length)return {weights,source:explicit?'catalogue_explicit':'catalogue_default'};}
 for(const [source,meta] of historical){const weights=defaultMuscleWeights(meta);if(Object.keys(weights).length)return {weights,source:source+'_default'};}
 return {weights:{},source:'unmapped'};
}
