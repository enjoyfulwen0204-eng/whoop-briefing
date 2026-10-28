// Evidence only: preserve both computation and physical cleanup failures.
export function preparedNativeFailure(primary,cleanup){
 return primary&&cleanup?new AggregateError([primary,cleanup],'NATIVE_PREPARED_PRIMARY_AND_CLEANUP_FAILED',{cause:primary}):primary??cleanup;
}
export function preparedNativeErrorSummary(error,depth=0){
 if(!error)return undefined;
 return {code:error.code??error.name,message:String(error.message).slice(0,300),
  ...(depth<3&&error.cause?{cause:preparedNativeErrorSummary(error.cause,depth+1)}:{}),
  ...(depth<3&&Array.isArray(error.errors)?{errors:error.errors.map(value=>preparedNativeErrorSummary(value,depth+1))}:{})};
}
