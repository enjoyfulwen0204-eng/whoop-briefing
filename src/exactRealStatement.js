// A finite binary64 is an exactly representable signed integer significand
// times one power of two. Hrana integers travel as decimal *strings*, avoiding
// the pinned JSON float decoder's one-ULP parameter error. Scaling uses only
// exact integer powers of two, each within signed64. No decimal REAL parser,
// optional SQL extension, approximation or changed comparison is involved.
const reject=()=>{throw Object.assign(Error('EXACT_REAL_STATEMENT_UNSUPPORTED'),{code:'EXACT_REAL_STATEMENT_UNSUPPORTED'});};
function realArgument(value){
 if(!Number.isFinite(value))reject();
 const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,value,false);
 const bits=bytes.getBigUint64(0,false),exponent=Number((bits>>52n)&2047n);
 let mantissa=(bits&((1n<<52n)-1n))+(exponent?1n<<52n:0n);
 if(bits>>63n)mantissa=-mantissa;
 let remaining=exponent?exponent-1075:-1074,sql='CAST(? AS REAL)';const args=[mantissa];
 while(remaining){const step=Math.min(62,Math.abs(remaining));sql+=(remaining>0?'*':'/')+'CAST(? AS REAL)';args.push(1n<<BigInt(step));remaining+=remaining>0?-step:step;}
 return {sql:'('+sql+')',args};
}

// Restricted to owned prepared statements with anonymous positional binds.
// SQL strings, quoted identifiers and comments are copied verbatim. Indexed
// and named placeholders fail closed rather than being rebound ambiguously.
export function exactRealStatement(statement){
 if(typeof statement==='string')return statement;
 if(!statement||typeof statement.sql!=='string')reject();
 const {sql,args=[]}=statement;
 if(!Array.isArray(args))reject();
 for(const value of args)if(typeof value==='number'&&!Number.isFinite(value))reject();
 if(!args.some(v=>typeof v==='number'&&!Number.isSafeInteger(v)))return statement;
 const values=[];let result='',index=0;
 for(let i=0;i<sql.length;){
  const ch=sql[i],next=sql[i+1];
  if(ch==='\''||ch==='"'||ch==='`'||ch==='['){
   const close=ch==='['?']':ch,start=i++;let closed=false;
   while(i<sql.length){if(sql[i++]===close){if(ch!=='['&&sql[i]===close){i++;continue;}closed=true;break;}}
   if(!closed)reject();result+=sql.slice(start,i);continue;
  }
  if(ch==='-'&&next==='-'){const end=sql.indexOf('\n',i+2),stop=end<0?sql.length:end;result+=sql.slice(i,stop);i=stop;continue;}
  if(ch==='/'&&next==='*'){const end=sql.indexOf('*/',i+2);if(end<0)reject();result+=sql.slice(i,end+2);i=end+2;continue;}
  if(ch===':'||ch==='@'||ch==='$')reject();
  if(ch!=='?'){result+=ch;i++;continue;}
  if(/[0-9]/.test(next??''))reject();
  if(index>=args.length)reject();
  const value=args[index++];
  if(typeof value==='number'&&!Number.isSafeInteger(value)){
   const real=realArgument(value);result+=real.sql;values.push(...real.args);
  }else{result+='?';values.push(value);}
  i++;
 }
 if(index!==args.length)reject();
 return {...statement,sql:result,args:values};
}
