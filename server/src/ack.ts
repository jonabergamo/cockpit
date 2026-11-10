// A turn that only says it heard ("Understood. Moving on.", "Thanks, looks good"): short, with no list, code or file
// in it, and nothing that turns it into a point ("Good catch, but the limit is still wrong"). Passing it on would only
// get one back, so a line stops there instead of spending a hop on it.
const ACK = /^(?:ok(?:ay)?|understood|got it|noted|thanks?(?: you)?|sounds good|great|good|perfect|alright|all right|will do|sure|agreed|makes sense|acknowledged|entendido|beleza|certo|combinado|valeu|obrigad[oa]|perfeito|blz)\b/i;
const POINT = /\b(?:but|however|though|although|still|except|unless|should|shouldn't|need|needs|must|missing|wrong|bug|broken|breaks|fails?|fix|issue|problem|instead|mas|por[eé]m|contudo|ainda|falta|faltou|errad[oa]|precisa|deveria|problema|quebr\w*)\b|\?/i;
export const onlyAcknowledges = (text: string) => {
  const t = text.trim();
  return t.length <= 240 && ACK.test(t) && !POINT.test(t) && !/```|`[^`]+`|^\s*(?:[-*•]|\d+[.)])\s/m.test(t) && !/\b[\w-]+\.[a-z]{1,5}(?::\d+)?\b/i.test(t);
};
