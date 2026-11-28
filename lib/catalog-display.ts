export type CatalogSelection = {model:string;groupId:string};

export function guidePath({model,groupId}:CatalogSelection) {
  return '/keys?'+new URLSearchParams({model,groupId})+'#connection-guide';
}

export function catalogPrice(micros:string,multiplierBps:number) {
  // USD per million tokens, with both the micro-dollar and basis-point scales.
  const digits = (BigInt(micros)*BigInt(multiplierBps)).toString().padStart(11,'0');
  const fraction = digits.slice(-10).replace(/0+$/,'').padEnd(2,'0');
  return 'USD '+digits.slice(0,-10)+'.'+fraction;
}
