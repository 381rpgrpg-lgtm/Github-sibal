const B='http://localhost:8080';
(async()=>{const build=(await (await fetch(B+'/api/version')).json()).build;
const lr=await (await fetch(B+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-dg-build':build},body:JSON.stringify({login:'damissi',password:'x'})})).json();
const H={authorization:'Bearer '+lr.token,'x-dg-build':build,'content-type':'application/json'};
const rpc=async(n,b={})=>(await (await fetch(B+'/api/rpc',{method:'POST',headers:H,body:JSON.stringify({name:n,body:b})})).json()).messages||[];
const [n,b]=[process.argv[2],JSON.parse(process.argv[3]||'{}')]; const m=await rpc(n,b);
const sel=process.argv[4]; for(const x of m){ let v=x.body; if(sel){ try { v=eval("v"+sel); } catch(e) { continue; } } console.log(x.name, String(JSON.stringify(v)).slice(0,3000)); }})();
