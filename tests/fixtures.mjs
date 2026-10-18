// Entirely fictional fixtures. Never import an account export or local config.
import { PersonalGymBridge } from '../src/plan.mjs';
export const catalogue={names:{a:'Synthetic bilateral press',b:'Synthetic single arm row',t:'Synthetic hold',assist:'Synthetic assisted pull'},exercises:{
  a:{id:'a',n:'Synthetic bilateral press',bp:'chest',eq:'dumbbell',primaries:['chest']},
  b:{id:'b',n:'Synthetic single arm row',bp:'back',eq:'dumbbell',primaries:['upper-back']},
  t:{id:'t',n:'Synthetic hold',bp:'waist',eq:'body weight',primaries:['abs']},
  assist:{id:'assist',n:'Synthetic assisted pull',bp:'back',eq:'leverage machine',primaries:['upper-back']},
}};
export const fixture=()=>({_rev:4,_wid:'synthetic-write-4',unit:'kg',routines:[{id:'r',name:'Synthetic routine',ex:[{id:'a',sets:2,reps:5,weight:3}]}],week:{},
  customEx:[],bodyweight:[],exWeights:{a:{w:5,d:'2000-01-01'}},opaque:{preserve:true},
  workouts:[{id:'w1',d:'2000-01-01',name:'Synthetic first',start:946728000000,end:946729800000,note:'虚构备注',media:['synthetic-media-reference'],extension:{retain:true},_ts:1,_f:{note:1},
    vol:25,prs:['a'],entries:[{id:'a',note:'虚构动作备注',media:['synthetic-entry-media'],muscleSnapshot:{n:'Synthetic bilateral press'},unknown:7,target:{dbLoad:'as',extra:9},topW:5,
      sets:[{w:5,r:5,done:true,rir:2,opaqueSet:'preserve'}]}]}]});
export class FakeClient{
  constructor(state=fixture()){this.data=structuredClone(state);this.rev=state._rev;this.puts=[];this.reads=0;}
  async refreshLogin(){return {user:{name:'Synthetic account'}};}
  async getData(){this.reads++;return {state:structuredClone(this.data),rev:this.rev};}
  async putData(payload){
    this.puts.push(structuredClone(payload));
    if(payload.baseRev!==this.rev||payload.baseWid!==this.data._wid)throw Object.assign(new Error('synthetic conflict'),{status:409});
    this.data=structuredClone(payload.state);this.data._rev=++this.rev;this.data._wid='synthetic-write-'+this.rev;
    for(const w of this.data.workouts||[]){w._ts=this.rev;w._f={...w._f,note:this.rev};}
    return {ok:true,rev:this.rev};
  }
}
export function setup(options={}){
  const client=options.client||new FakeClient();const backups=[];
  const backup=options.backup||{create:async(snapshot,operation)=>{backups.push({snapshot:structuredClone(snapshot),operation});return {id:'synthetic-local-backup',source_revision:snapshot.rev};}};
  const bridge=new PersonalGymBridge({client,writes:true,backup,loadCatalogue:async()=>structuredClone(catalogue),...options});
  return {bridge,client,backups};
}
export const approve=proposal=>({proposal_id:proposal.proposal_id,confirmation:'我确认写入'});
export const customCreate={type:'create',name:'Synthetic custom movement',body_part:'back',equipment:'dumbbell',primary_muscles:['upper-back'],secondary_muscles:['biceps'],description:'虚构说明'};
export const logInput={workouts:[{date:'2000-02-01',name:'Synthetic later workout',exercises:[{exercise_id:'b',sets:[{weight:2,reps:3}]}]}]};
