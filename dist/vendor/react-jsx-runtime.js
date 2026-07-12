var d=Object.create;var l=Object.defineProperty;var v=Object.getOwnPropertyDescriptor;var k=Object.getOwnPropertyNames;var T=Object.getPrototypeOf,a=Object.prototype.hasOwnProperty;var u=(e,r)=>()=>{try{return r||e((r={exports:{}}).exports,r),r.exports}catch(t){throw r=0,t}};var m=(e,r,t,o)=>{if(r&&typeof r=="object"||typeof r=="function")for(let s of k(r))!a.call(e,s)&&s!==t&&l(e,s,{get:()=>r[s],enumerable:!(o=v(r,s))||o.enumerable});return e};var _=(e,r,t)=>(t=e!=null?d(T(e)):{},m(r||!e||!e.__esModule?l(t,"default",{value:e,enumerable:!0}):t,e));var j=u(x=>{"use strict";var c=Symbol.for("react.transitional.element"),f=Symbol.for("react.fragment");function i(e,r,t){var o=null;if(t!==void 0&&(o=""+t),r.key!==void 0&&(o=""+r.key),"key"in r){t={};for(var s in r)s!=="key"&&(t[s]=r[s])}else t=r;return r=t.ref,{$$typeof:c,type:e,key:o,ref:r!==void 0?r:null,props:t}}x.Fragment=f;x.jsx=i;x.jsxs=i});var E=u((P,p)=>{"use strict";p.exports=j()});var n=_(E()),R=n.default,q=n.default.Fragment,C=n.default.jsx,M=n.default.jsxs;export{q as Fragment,R as default,C as jsx,M as jsxs};
/*! Bundled license information:

react/cjs/react-jsx-runtime.production.js:
  (**
   * @license React
   * react-jsx-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
