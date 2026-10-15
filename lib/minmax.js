'use strict';
// Min/max rayon dérivés d'une proposition : la valeur proposée au scan est le
// MAX rayon, le min descend d'un colisage (VPE).
//   Max = proposition ; Min = proposition − VPE.
// Si la proposition ne couvre pas un VPE (min ≤ 0) : Min = ½ VPE et Max = 1,5 VPE,
// arrondis à l'entier supérieur. VPE absent ou nul : traité comme 1.

function calculerMinMax(proposition, vpe) {
  const colis = vpe > 0 ? vpe : 1;
  const prop = proposition > 0 ? proposition : 0;
  const min = prop - colis;
  if (min <= 0) return { min: Math.ceil(colis / 2), max: Math.ceil(colis * 1.5) };
  return { min, max: prop };
}

module.exports = { calculerMinMax };
