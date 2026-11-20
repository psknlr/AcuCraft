import type { ManipulationTechniqueId } from "../schema/manipulation.js";

/**
 * How each of the 36 techniques is done, as a practitioner would be taught it: what it is for, what each hand does,
 * the numbers that go with it, and what to watch for. The text of the operative catalogue (`operation.ts`), shown
 * beside the 3D performance and served to a model through `lookup techniques`.
 *
 * Authored from the classical accounts — the eight methods of the 《针灸大成》, the fourteen of the 《针经指南》, the
 * compound methods of the 《金针赋》 — and the arrangement of twenty-four single methods taught after 陆瘦燕, with the
 * modern textbook reading of reinforcing and reducing. It is NOT reviewed by a practitioner, the classical lines are
 * given as commonly printed and have not been collated against an edition, and where the sources differ one common
 * reading was chosen and the entry says so. A teaching aid, not a clinical standard.
 */

/** The six groups of four of the twenty-four single methods, then the compound methods and the two bare labels. */
export const TECHNIQUE_GROUPS = [
  { id: "channel", zh: "揣爪循摄", label: "On the skin and along the channel", note: "The pressing hand finds and prepares the point, and calls or frees the qi along the channel." },
  { id: "turning", zh: "摇盘捻搓", label: "Turning the handle", note: "The needle hand rocks, circles, twirls or winds the needle about its own entry." },
  { id: "levels", zh: "进退提插", label: "Along the shaft", note: "The tip travels between the shallow, middle and deep levels, or is lifted and thrust within one." },
  { id: "handle", zh: "刮弹飞摩", label: "Light work on the handle", note: "A fine vibration is sent down the needle without moving its tip." },
  { id: "shaft", zh: "动推颤弩", label: "Small movements of the shaft", note: "The needle is stirred, pushed, trembled or bowed to move the qi it has found." },
  { id: "closing", zh: "按扪搜拨", label: "Pressing, closing, searching, levering", note: "The channel is pressed, the hole closed, the response looked for, a tight band released." },
  { id: "compound", zh: "复式手法", label: "Compound methods", note: "The single methods combined by level, count and direction: fire and coolness, the four that carry qi along the channel, and the mixed methods." },
  { id: "bu-xie", zh: "补泻", label: "Reinforcing and reducing", note: "The two bare forms: every contrast of the single methods taken one way." },
] as const;
export type TechniqueGroupId = (typeof TECHNIQUE_GROUPS)[number]["id"];

export interface TechniqueCard {
  group: TechniqueGroupId;
  /** Toneless pinyin, as the technique is named in English text. */
  pinyin: string;
  /** The English name. */
  name: string;
  /** What it is for. */
  aim: string;
  /** What the hands do, in order. */
  method: string[];
  /** The line it is taught by, in Chinese, with where it is from. */
  formula: { zh: string; from: string } | null;
  /** The numbers and qualities that go with it: amplitude, tempo, count, direction, breath, the hole. */
  essentials: string[];
  /** What to watch for. */
  cautions: string[];
  /** What the simulation does when it is performed on the operative catalogue, and what it leaves out. */
  simulation: string;
}

const JZF = "《金针赋》";
const NJ78 = "《难经 · 七十八难》";
const ZJZN = "《针经指南》";
const ZJDC = "《针灸大成》";

export const TECHNIQUE_CARDS: Readonly<Record<ManipulationTechniqueId, TechniqueCard>> = {
  /* ---------------------------------------------------------------- 揣爪循摄 */
  chuai: {
    group: "channel", pinyin: "chuai", name: "Palpating for the point",
    aim: "Find where the point actually is on this patient, and what lies under it, before the skin is cleaned.",
    method: [
      "The pad of the pressing hand's thumb (or index finger) is laid on the measured location.",
      "It presses and kneads in small circles, then slides a little each way, feeling for the hollow, the gap between tendons or bones, and any pulse to be avoided.",
      "Tendons and vessels are moved aside, and the patient is asked where it is sore or distended.",
    ],
    formula: { zh: "揣而寻之", from: `${ZJDC} · 下手八法` },
    essentials: ["Light at first, then firmer.", "A few small circles, then to and fro.", "Done before the skin is disinfected."],
    cautions: ["Palpating cleaned skin undoes its preparation: prepare the site again before a needle goes in."],
    simulation: "A kneading path at the site, then a settling press. It touches the skin, so a prepared site is no longer prepared.",
  },
  zhua: {
    group: "channel", pinyin: "zhua", name: "Pressing with the nail",
    aim: "Fix the point, part the qi and blood so that the prick is less felt, and give the needle an edge to enter against.",
    method: [
      "The thumbnail of the pressing hand is set on the point and pressed in firmly.",
      "A second press at a right angle leaves a small cross on the skin.",
      "With the nail still pressing, the needle is entered against its edge (the nail-pressing insertion, 指切进针).",
    ],
    formula: { zh: "爪而下之", from: `${ZJDC} · 下手八法` },
    essentials: ["Firm, steady pressure for two or three seconds.", "Two presses, crossed.", "Before disinfection, or the site is prepared again."],
    cautions: ["Not on broken or inflamed skin.", "Pressure enough to mark the skin, not to bruise it."],
    simulation: "Two crossed nail contacts at the site, drawn with the index nail: the hand model has no thumbnail contact. Contact intensity is shown, not measured.",
  },
  xun: {
    group: "channel", pinyin: "xun", name: "Stroking along the channel",
    aim: "Bring the qi to a needle that has not found it, or carry it along the channel; it also eases a needle the tissue has seized.",
    method: [
      "The pads of the index, middle and ring fingers are laid on the channel beside the point.",
      "They stroke and press lightly along it, away from the point and back, above it and below it.",
      "Several passes, until the needle is felt to grow heavy or the patient reports the sensation.",
    ],
    formula: { zh: "循者，凡下针于属部分经络之处，用手上下循之，使气血往来而已", from: ZJZN },
    essentials: ["Gentle, even pressure.", "Along the channel, a few centimetres each way from the point.", "Three or more passes."],
    cautions: ["It handles the skin: with a needle in place, keep clear of the needle and of its prepared entry."],
    simulation: "To-and-fro strokes along the chart's long axis for the travel set. Named with a retained needle, it is a small stimulus to that needle and lets go some of a wound needle's hold.",
  },
  she: {
    group: "channel", pinyin: "she", name: "Nipping along the channel",
    aim: "Free qi that has stagnated at a needle: the remedy for a needle that will not turn or lift.",
    method: [
      "The thumbnail (with the index and middle nails) is pressed into the channel a little below the point, held, and released.",
      "The same at stations along the channel, below the point and then above it.",
      "The needle is tried again once the tissue has let go.",
    ],
    formula: { zh: "摄者，下针如气涩滞，随经络上下用大指甲上下切之，其气血自得通行也", from: ZJZN },
    essentials: ["Firm, brief nips.", "Four stations: two below, two above.", "Along the channel of the needle."],
    cautions: ["Nail pressure on skin, not on the needle.", "A needle wound by one-way twirling is also unwound by twirling it back."],
    simulation: "Nail contacts at four stations along the chart's long axis, drawn with the index nail. Named with a retained needle, it lets go more of a wound needle's hold than stroking does.",
  },
  /* ---------------------------------------------------------------- 摇盘捻搓 */
  yao: {
    group: "turning", pinyin: "yao", name: "Rocking the needle",
    aim: "Move the qi; and, as the needle comes out, widen the hole so that what is to be reduced can leave.",
    method: [
      "Thumb and index finger hold the handle, the middle finger steadying.",
      "The needle is rocked from side to side about its entry — upright to widen the hole and strengthen the sensation, or laid over to send the sensation one way.",
      "When reducing, it is rocked as it is withdrawn and the hole is left open.",
    ],
    formula: { zh: "摇者，凡泻时，欲出针，必须动摇而出者是也", from: ZJZN },
    essentials: ["Slow and even.", "Six times when reducing (a yin number).", "The tip stays where it is: only the shaft above the skin sways."],
    cautions: ["Never over the chest, back or abdomen at a depth where a swaying tip matters: here the tip does not move, in a patient it does."],
    simulation: "The exposed shaft and handle sway about the fixed entry; the path inside the patient does not change. A light stimulus; it reads as reducing only as part of a withdrawal.",
  },
  pan: {
    group: "turning", pinyin: "pan", name: "Circling the needle",
    aim: "Spread and harmonise the sensation at soft, thick sites — classically the abdomen.",
    method: [
      "With the needle at a shallow level, the handle is leaned over.",
      "It is carried round in full circles about the entry, like turning a millstone.",
      "Classically five circles each way: to the left pressing in to reinforce, to the right lifting to reduce.",
    ],
    formula: { zh: "盘者，为如针腹部，于穴内轻盘摇而已", from: ZJZN },
    essentials: ["Full, slow circles.", "Five circles.", "Only where the tissue is soft and thick."],
    cautions: ["Not at points over bone, tendon or a joint.", "The needle must not be kinked."],
    simulation: "The handle orbits the entry axis at the lateral excursion set, in the direction set. The internal path stays fixed.",
  },
  nian: {
    group: "turning", pinyin: "nian", name: "Twirling",
    aim: "The basic rotating manipulation: it obtains the qi and regulates it, and its direction and force carry reinforcing or reducing.",
    method: [
      "Thumb and index finger (the middle may help) hold the handle.",
      "The handle is rolled to and fro between them, the needle turning about its own axis at its depth.",
      "Turned mostly thumb-forward, small and gentle, it reinforces; mostly thumb-backward, wide and strong, it reduces.",
    ],
    formula: { zh: "左转（拇指向前）为补，右转（拇指向后）为泻", from: "捻转补泻 (textbook reading)" },
    essentials: ["An arc of about 180° to 360°.", "Even both ways for ordinary stimulation, around two a second.", "Never one way only: the fibres wind round the shaft."],
    cautions: ["Twirling one way binds the needle (滞针) and hurts.", "The depth does not change."],
    simulation: "Alternating rotation about the shaft at the arc set. It stimulates the needle and tells the operator how the tissue holds it.",
  },
  cuo: {
    group: "turning", pinyin: "cuo", name: "Winding",
    aim: "Hold the qi the needle has found and strengthen the sensation, by letting the fibres lightly take hold of the shaft.",
    method: [
      "The handle is rolled one way only, like twisting a thread, the fingers taking a fresh hold between rolls.",
      "Two or three rolls, stopping as soon as the needle feels held — never tight.",
      "Before the needle is withdrawn it is rolled back the other way until it is free.",
    ],
    formula: { zh: "搓而转者，如搓线之状，勿转太紧", from: `${ZJDC} · 下手八法` },
    essentials: ["One direction.", "Stop when the needle is held.", "Undo it before withdrawal."],
    cautions: ["Wound too far the needle is stuck: it will not turn or lift, and pulling it hurts and bleeds.", "Free a stuck needle by rolling it back, stroking (循) or nipping (摄) along the channel, or flicking and scraping the handle — never by force."],
    simulation: "One-way rotation is kept as winding on the needle: from half a turn the needle is held (a stronger response), from a turn and a half it is stuck. Rolling back, 循, 摄, 弹 and 刮 let it go.",
  },
  /* ---------------------------------------------------------------- 进退提插 */
  jin: {
    group: "levels", pinyin: "jin", name: "Advancing by levels",
    aim: "Take the needle to its depth in steps, waiting for the qi at each: the slow way in that reinforcing uses.",
    method: [
      "From the shallow level (天) the needle is advanced with a small twirl to the middle level (人), and held.",
      "Then to the deep level (地), and held.",
      "At each level the operator waits for the needle to grow heavy before going on.",
    ],
    formula: { zh: "先浅后深，三进", from: "分层进针 (teaching summary)" },
    essentials: ["Slow.", "A pause at each level.", "Never past the depth set for the point."],
    cautions: ["The depth is set by adjust_needle against this patient's anatomy: the levels are thirds of that depth, not a way to go deeper."],
    simulation: "The tip is drawn back to the shallow third, then advanced through the middle third to the depth the needle stands at. It ends where it began.",
  },
  "tui-withdraw": {
    group: "levels", pinyin: "tui", name: "Withdrawing by levels",
    aim: "Bring the needle back in steps before it comes out, or to change what is being done: the slow way out that reducing uses.",
    method: [
      "From the deep level (地) the needle is drawn back to the middle level (人), and held.",
      "Then to the shallow level (天), and held.",
      "From there it is withdrawn, or advanced again.",
    ],
    formula: { zh: "先深后浅，三退", from: "分层退针 (teaching summary)" },
    essentials: ["Slow.", "A pause at each level.", "Taking the needle out of the skin is remove_needle."],
    cautions: ["The needle stays in the patient: this is not its removal."],
    simulation: "The tip is drawn back through the middle third to the shallow third, then returned to the depth the needle stands at.",
  },
  ti: {
    group: "levels", pinyin: "ti", name: "Lifting",
    aim: "The lifting half of lifting and thrusting: quick, forceful lifts with slow thrusts reduce.",
    method: [
      "The needle is drawn briskly from its depth toward the shallower level along its own path.",
      "It is let back to its depth slowly and lightly.",
      "The same again, at an even rhythm.",
    ],
    formula: { zh: "紧提慢按为泻", from: "提插补泻" },
    essentials: ["A stroke of a few millimetres.", "About one a second.", "The force is on the lift."],
    cautions: ["The angle and the depth of the needle do not change.", "A wide stroke is strong stimulation."],
    simulation: "Quick lift, slow return, never deeper than the depth the needle stands at. Reads as reducing.",
  },
  cha: {
    group: "levels", pinyin: "cha", name: "Thrusting",
    aim: "The thrusting half of lifting and thrusting: quick, forceful thrusts with slow lifts reinforce.",
    method: [
      "The needle is lifted slowly and lightly a little way from its depth.",
      "It is pressed back to its depth briskly.",
      "The same again, at an even rhythm.",
    ],
    formula: { zh: "紧按慢提为补", from: "提插补泻" },
    essentials: ["A stroke of a few millimetres.", "About one a second.", "The force is on the thrust."],
    cautions: ["The thrust returns to the depth already set, never beyond it."],
    simulation: "Slow lift, quick thrust back to the depth the needle stands at. Reads as reinforcing.",
  },
  /* ---------------------------------------------------------------- 刮弹飞摩 */
  gua: {
    group: "handle", pinyin: "gua", name: "Scraping the handle",
    aim: "Hasten or spread the sensation without turning the needle: for a patient who bears twirling badly.",
    method: [
      "The thumb pad rests on the tail of the handle to steady it.",
      "The nail of the index (or middle) finger scrapes the handle from below upward, lifts off, and comes back.",
      "Light, even and frequent, so that the wound handle sends a fine vibration down the shaft.",
    ],
    formula: { zh: "以指甲刮针柄", from: "刮法 (teaching summary; some sources read upward as reducing, downward as reinforcing)" },
    essentials: ["The needle does not turn or change depth.", "Eight or so scrapes.", "Light."],
    cautions: ["Steady the tail, or the needle is pushed deeper."],
    simulation: "The index nail travels up the handle and returns; the needle quivers. A small stimulus; it lets go a little of a wound needle's hold.",
  },
  tan: {
    group: "handle", pinyin: "tan", name: "Flicking the handle",
    aim: "Hasten the qi with a quiver of the shaft.",
    method: [
      "The index finger is caught behind the thumb.",
      "It is let go against the handle or its tail, lightly.",
      "The needle is left to quiver, and flicked again.",
    ],
    formula: { zh: "弹者，凡补时，可用大指甲轻弹针，使气疾行也", from: ZJZN },
    essentials: ["Light.", "Six to ten flicks.", "A pause after each."],
    cautions: ["A hard flick bends the needle.", "Not on a needle near the eye, or where the tip lies over an organ."],
    simulation: "A flick and the shaft's dying quiver, repeated. A small stimulus; it lets go a little of a wound needle's hold.",
  },
  fei: {
    group: "handle", pinyin: "fei", name: "Flying",
    aim: "Hasten the qi and carry it on.",
    method: [
      "Thumb and index finger twirl the handle lightly a few times.",
      "They spring apart, the fingers opening like a bird's wings, and the needle is left to quiver.",
      "One twirl, one release — again and again.",
    ],
    formula: { zh: "以大指次指捻针，连搓三下，如手颤之状，谓之飞", from: "《医学入门》" },
    essentials: ["Three small twirls, then release.", "Three or more times.", "The fingers leave the handle completely."],
    cautions: ["Light: the needle is not driven deeper."],
    simulation: "Three small thumb-forward twirls, then the fingers open and the needle quivers; repeated. A moderate stimulus.",
  },
  mo: {
    group: "handle", pinyin: "mo", name: "Rubbing the handle",
    aim: "Keep a sensation going with the finest of stimuli.",
    method: [
      "Thumb and index pads hold the handle lightly.",
      "They rub up and down it without turning the needle or moving its tip.",
    ],
    formula: null,
    essentials: ["Very light.", "The needle neither turns nor moves.", "Sources word this method differently: this is one common reading."],
    cautions: [],
    simulation: "A sliding contact on the handle with almost no movement of the needle. A very small stimulus.",
  },
  /* ---------------------------------------------------------------- 动推颤弩 */
  dong: {
    group: "shaft", pinyin: "dong", name: "Stirring",
    aim: "Set moving a qi that will not move.",
    method: [
      "The needle is lifted a little.",
      "It is moved slightly from side to side as it is let back.",
      "A few times, then the response is looked for again.",
    ],
    formula: { zh: "动者，如气不行，将针伸提而已", from: ZJZN },
    essentials: ["Half strokes.", "A slight sway.", "Four or so.", `The ${NJ78} pairs it with pushing: 动而伸之 (move and draw out) reduces, 推而内之 (push and send in) reinforces; here both are read as neither, as methods that move the qi.`],
    cautions: [],
    simulation: "Half-strokes outward with a small sway of the exposed shaft. A light stimulus.",
  },
  "tui-push": {
    group: "shaft", pinyin: "tui", name: "Pushing",
    aim: "Drive on the sensation the needle has found.",
    method: [
      "With the qi obtained, the thumb pushes the handle forward a little — a small one-way turn.",
      "A steady inward pressure is held, without the tip going any deeper.",
      "It is released, and done again.",
    ],
    formula: { zh: "得气，因推而内之，是谓补", from: NJ78 },
    essentials: ["A small thumb-forward turn, held.", "Three times.", "No deeper."],
    cautions: ["Pressure, not travel: the depth set for the point is not exceeded."],
    simulation: "A small thumb-forward turn held and released; the tip does not move. A light stimulus that winds the needle slightly.",
  },
  chan: {
    group: "shaft", pinyin: "chan", name: "Trembling",
    aim: "Hasten the qi and strengthen the sensation.",
    method: [
      "The handle is held firmly.",
      "The hand makes very small, quick lifts and thrusts with a hint of twirl, so that the whole needle trembles.",
    ],
    formula: { zh: "小幅度、快频率的提插捻转，使针身轻微震颤", from: "震颤法 (textbook)" },
    essentials: ["Strokes of a fraction of a millimetre.", "Five or six a second.", "A couple of seconds at a time."],
    cautions: [],
    simulation: "Sub-millimetre strokes with a slight sway and twirl, at about six a second. A moderate stimulus.",
  },
  nu: {
    group: "shaft", pinyin: "nu", name: "Bowing the needle",
    aim: "Send the sensation one way, toward where it is wanted.",
    method: [
      "Thumb and index finger hold the handle.",
      "The middle finger presses the shaft so that it bows like a drawn crossbow, the tip toward where the qi is to go.",
      "It is held for a few breaths and let go.",
    ],
    formula: { zh: "如拨弩机之状", from: "弩法 (as commonly described, after the 《针灸问对》)" },
    essentials: ["A three-finger hold.", "Held, not pumped.", "Twice or so."],
    cautions: ["Gentle: a needle bowed too far kinks."],
    simulation: "The exposed shaft bows and is held, under a three-finger hold. The internal path does not change. A moderate stimulus.",
  },
  /* ---------------------------------------------------------------- 按扪搜拨 */
  an: {
    group: "closing", pinyin: "an", name: "Pressing the channel",
    aim: "Close the channel on one side of the needle so that the qi goes the other way.",
    method: [
      "A finger of the pressing hand is set on the channel just above or just below the needle.",
      "It presses firmly and holds while the needle is worked.",
      "Pressed in front, the qi goes behind; pressed behind, it goes in front.",
    ],
    formula: { zh: "按之在前，使气在后；按之在后，使气在前", from: JZF },
    essentials: ["Firm, steady, held.", "Beside the needle, on its channel.", "Sources also use 按 for holding the needle pressed at its depth without moving it."],
    cautions: ["It handles the skin beside a needle: keep clear of the entry."],
    simulation: "A held press at the site — beside the needle, along the chart's long axis, when a retained needle is named. A very small stimulus to that needle.",
  },
  men: {
    group: "closing", pinyin: "men", name: "Closing the hole",
    aim: "Close the hole as the needle leaves it, so that what was reinforced does not leak: the reinforcing end of opening and closing (开阖补泻). It also stops oozing.",
    method: [
      "As the needle comes out, a finger over a dry sterile swab presses on the hole at once.",
      "It kneads lightly and holds.",
    ],
    formula: { zh: "扪者，凡补时，用手扪闭其穴是也", from: ZJZN },
    essentials: ["At once, on the hole itself.", "Press, knead a little, hold.", "When reducing the hole is left open instead."],
    cautions: ["Only after the needle is out and accounted for."],
    simulation: "A press with a small kneading circle on the hole of a needle withdrawn in this visit. It stops bleeding there and the hole is recorded as closed.",
  },
  sou: {
    group: "closing", pinyin: "sou", name: "Searching",
    aim: "Look for the sensation when it has not come in the first direction.",
    method: [
      "The needle is drawn back to the shallow level.",
      "It is advanced a little forward, back, to the left and to the right in turn, feeling each time for the response.",
      "Where the needle grows heavy, it is left.",
    ],
    formula: { zh: "退至浅层，更换方向，前后左右以寻针感", from: "搜法 (teaching summary)" },
    essentials: ["Shallow before every change of direction.", "Four directions.", "Slow."],
    cautions: ["A change of direction inside the patient is a new path past new structures: here it is shown outside the skin only. To really redirect a needle, withdraw it and insert again."],
    simulation: "The needle is drawn back by half and re-advanced while the exposed shaft leans to four sides in turn. The path inside the patient is never redirected.",
  },
  bo: {
    group: "closing", pinyin: "bo", name: "Levering",
    aim: "Release a tight band or an adhesion beside the tip.",
    method: [
      "With the needle at its depth, the handle is levered sideways across the fibres, like plucking a string.",
      "A pause, and again — a few times only.",
    ],
    formula: { zh: "分筋拨络", from: "拨法 (teaching summary)" },
    essentials: ["Small, across the fibres.", "Four or so, with pauses.", "Strong stimulation."],
    cautions: ["Not beside a vessel or a nerve."],
    simulation: "The exposed shaft is levered to each side with a pause between. The internal path stays fixed. A strong stimulus for a single method.",
  },
  /* ---------------------------------------------------------------- 复式手法 */
  "shao-shan-huo": {
    group: "compound", pinyin: "shao shan huo", name: "Setting the mountain on fire",
    aim: "Bring warmth under the needle: for cold, numbness and deficiency.",
    method: [
      "The depth of the point is taken in three levels: shallow (天), middle (人), deep (地).",
      "At the shallow level the needle is thrust quickly and lifted slowly nine times; then advanced to the middle level, nine times; then to the deep level, nine times.",
      "It is brought back to the shallow level in one move (three advances, one withdrawal) and the whole repeated until warmth comes.",
      "It goes in on the out-breath; at the end it is left at the deep level, and on withdrawal the hole is pressed closed at once.",
    ],
    formula: { zh: "烧山火，治顽麻冷痹，先浅后深，凡九阳而三进三退，慢提紧按，热至，紧闭插针，除寒之有准", from: JZF },
    essentials: ["Shallow first, then deep.", "Nine at each level: quick thrust, slow lift.", "Advance on the out-breath; close the hole.", "The 《金针赋》 has three advances and three withdrawals (三进三退); later texts and present teaching have three advances and one withdrawal (三进一退), the reading used here."],
    cautions: ["Needs a point with tissue deep enough for three levels.", "It is heavy stimulation: a second round is more than many patients bear."],
    simulation: "One round: back to the shallow third, nine thrust-led strokes at each third, ending at the depth the needle stands at. A heavy, reinforcing stimulus; a patient whose needle has the qi may then report warmth.",
  },
  "tou-tian-liang": {
    group: "compound", pinyin: "tou tian liang", name: "Coolness through the heavens",
    aim: "Bring coolness under the needle: for heat and excess.",
    method: [
      "The needle is taken straight to the deep level (地).",
      "There it is lifted quickly and thrust slowly six times; drawn back to the middle level (人), six times; drawn back to the shallow level (天), six times.",
      "It is returned to the deep level in one move (one advance, three withdrawals) and the whole repeated until coolness comes.",
      "It goes in on the in-breath; on withdrawal the needle is rocked to widen the hole, which is left open.",
    ],
    formula: { zh: "透天凉，治肌热骨蒸，先深后浅，用六阴而三出三入，紧提慢按，徐徐举针，退热之可凭", from: JZF },
    essentials: ["Deep first, then shallow.", "Six at each level: quick lift, slow thrust.", "Withdraw on the out-breath; leave the hole open.", "The 《金针赋》 has three out and three in (三出三入); present teaching has one advance and three withdrawals (一进三退), the reading used here."],
    cautions: ["Needs a point with tissue deep enough for three levels.", "Classically the needle is then left at the shallow level: here it returns to the depth it stood at — follow with adjust_needle to leave it shallower."],
    simulation: "One round: six lift-led strokes at the deep, middle and shallow thirds, then back to the depth the needle stands at. A heavy, reducing stimulus; a patient whose needle has the qi may then report coolness.",
  },
  "qing-long-bai-wei": {
    group: "compound", pinyin: "qing long bai wei", name: "The green dragon sways its tail",
    aim: "Carry the qi along the channel toward where it is wanted: the first of the four methods of 飞经走气; reinforcing.",
    method: [
      "With the qi obtained, the needle is lifted to the shallow level and leaned toward where the qi is to go.",
      "Without advancing or withdrawing, the handle is moved slowly to the left and to the right, like holding a boat's tiller.",
      "Nine times, or three nines.",
    ],
    formula: { zh: "青龙摆尾，如扶船舵，不进不退，一左一右，慢慢拨动", from: JZF },
    essentials: ["Shallow.", "Slow, nine sways.", "Neither in nor out."],
    cautions: ["The lean is toward the disease, along the channel."],
    simulation: "The needle is drawn back to the shallow third, the exposed shaft leaned along the chart's long axis and swayed slowly nine times, then stood up and returned. Reads as reinforcing.",
  },
  "bai-hu-yao-tou": {
    group: "compound", pinyin: "bai hu yao tou", name: "The white tiger shakes its head",
    aim: "Carry the qi along the channel: the second of the four methods of 飞经走气; reducing.",
    method: [
      "With the needle at the deep level, the handle is held and the shaft shaken from side to side like ringing a hand bell.",
      "It is shaken while it is lifted, six times.",
      "It is thrust back with a turn, and the whole done again.",
    ],
    formula: { zh: "白虎摇头，似手摇铃，退方进圆，兼之左右，摇而振之", from: JZF },
    essentials: ["Deep.", "Brisk: six shakes while lifting.", "Thrust back with a turn; twice."],
    cautions: ["Not over the chest or abdomen at a depth where a shaking tip matters."],
    simulation: "Six brisk sways of the exposed shaft while the tip is lifted by a third, then a turning thrust back; two rounds. Reads as reducing.",
  },
  "cang-gui-tan-xue": {
    group: "compound", pinyin: "cang gui tan xue", name: "The dark turtle probes its hole",
    aim: "Carry the qi into the deep channels: the third of the four methods of 飞经走气; reinforcing.",
    method: [
      "The needle is drawn back to just under the skin.",
      "It is advanced obliquely upward in three steps — shallow, middle, deep — and drawn back in one.",
      "The same downward, to the left and to the right: one withdrawal and three advances, boring to the four sides like a turtle digging in.",
    ],
    formula: { zh: "苍龟探穴，如入土之象，一退三进，钻剔四方", from: JZF },
    essentials: ["Four directions.", "Three steps in, one out, each time.", "Slow."],
    cautions: ["Four directions inside a patient are four paths past different structures: here the changes are shown outside the skin only, and the internal path is never redirected."],
    simulation: "For each of four sides the exposed shaft leans that way while the tip advances in three steps along its one approved path and is drawn back in one. Reads as reinforcing.",
  },
  "chi-feng-ying-yuan": {
    group: "compound", pinyin: "chi feng ying yuan", name: "The red phoenix meets the source",
    aim: "Carry the qi past the joints: the fourth of the four methods of 飞经走气; reducing.",
    method: [
      "The needle is taken to the deep level, then lifted to the shallow level and left until it stirs of itself.",
      "It is advanced again to the middle level.",
      "There it is twirled and released — the fingers opening like a phoenix spreading its wings — above, below, left and right, flying round on all four sides.",
    ],
    formula: { zh: "赤凤迎源，展翅之仪，入针至地，提针至天，候针自摇，复进其原，上下左右，四围飞旋", from: JZF },
    essentials: ["Deep, then shallow, then the middle.", "Twirl and release to the four sides.", "The fingers leave the handle each time."],
    cautions: [],
    simulation: "The tip is lifted to the shallow third, waits, returns to the middle third, and the flying method is done eight times with the shaft leaning to four sides in turn; then back to its depth. Reads as reducing.",
  },
  "long-hu-jiao-zhan": {
    group: "compound", pinyin: "long hu jiao zhan", name: "Dragon and tiger do battle",
    aim: "Stop pain: reinforcing and reducing by turns.",
    method: [
      "The dragon: the needle is twirled to the left — thumb forward — nine times.",
      "The tiger: it is twirled to the right — thumb backward — six times.",
      "Dragon and tiger alternate, round after round.",
    ],
    formula: { zh: "龙虎交战，左捻九而右捻六，是亦住痛之针", from: JZF },
    essentials: ["Nine to the left, six to the right.", "Each twirl returns: the needle is not wound.", "Two rounds or more."],
    cautions: ["Each twirl is let back: turning one way without return winds the needle."],
    simulation: "Nine thumb-forward twirls, then six thumb-backward, each let back; two rounds. A strong stimulus that reads as mixed.",
  },
  "zi-wu-dao-jiu": {
    group: "compound", pinyin: "zi wu dao jiu", name: "Pounding the mortar",
    aim: "Move water and qi that have gathered: for swelling and fullness. Reinforcing and reducing together.",
    method: [
      "With the qi obtained and made even, the needle is advanced in three steps, each a quick thrust with a turn to the left.",
      "It is drawn back in two steps, each a quick lift with a turn to the right.",
      "Three rounds: nine in and six out.",
    ],
    formula: { zh: "子午捣臼，水蛊膈气，落穴之后，调气均匀，针行上下，九入六出，左右转之，千遭自平", from: JZF },
    essentials: ["Three steps in, two out.", "Left turn going in, right turn coming out.", "Three rounds."],
    cautions: ["Needs room between the shallow level and the depth of the point."],
    simulation: "Three rounds of three turning thrusts in and two turning lifts out between the shallow quarter and the depth the needle stands at. A heavy stimulus that reads as mixed.",
  },
  "yang-zhong-yin-yin": {
    group: "compound", pinyin: "yang zhong yin yin", name: "Yin hidden in yang",
    aim: "Reinforce first, then reduce: for cold followed by heat, deficiency holding excess.",
    method: [
      "At the shallow level the needle is thrust quickly and lifted slowly nine times, until a little warmth is felt.",
      "It is advanced to the deep level.",
      "There it is lifted quickly and thrust slowly six times.",
    ],
    formula: { zh: "阳中隐阴，先寒后热，浅而深，以九六之法，则先补后泻也", from: JZF },
    essentials: ["Shallow nine, then deep six.", "Reinforce, then reduce."],
    cautions: [],
    simulation: "Nine thrust-led strokes at half depth, then six lift-led strokes at the depth the needle stands at. Reads as mixed.",
  },
  "yin-zhong-yin-yang": {
    group: "compound", pinyin: "yin zhong yin yang", name: "Yang hidden in yin",
    aim: "Reduce first, then reinforce: for heat followed by cold, excess holding deficiency.",
    method: [
      "At the deep level the needle is lifted quickly and thrust slowly six times, until a little coolness is felt.",
      "It is drawn back to the shallow level.",
      "There it is thrust quickly and lifted slowly nine times.",
    ],
    formula: { zh: "阴中隐阳，先热后寒，深而浅，以六九之方，则先泻后补也", from: JZF },
    essentials: ["Deep six, then shallow nine.", "Reduce, then reinforce."],
    cautions: [],
    simulation: "Six lift-led strokes at the depth the needle stands at, then nine thrust-led strokes at half depth, and back. Reads as mixed.",
  },
  /* ---------------------------------------------------------------- 补泻 */
  bu: {
    group: "bu-xie", pinyin: "bu", name: "Reinforcing",
    aim: "Every contrast of lifting-thrusting and twirling taken the reinforcing way.",
    method: [
      "The needle is thrust quickly and firmly and lifted slowly and lightly, by a small stroke, at a slow rhythm.",
      "With each thrust the thumb goes forward a little — a small turn to the left — and is let back.",
      "Nine times. By the other single methods: in slowly and out fast, in on the out-breath, along the channel, and the hole closed.",
    ],
    formula: { zh: "紧按慢提，拇指向前；徐入疾出，呼进吸出，随而济之，扪闭其穴", from: "单式补泻 (textbook summary)" },
    essentials: ["Small stroke, small arc, slow, short.", "The force on the thrust and on the thumb going forward.", "Nine — a yang number."],
    cautions: ["Reinforcing and reducing are a traditional reading of how the needle is worked: the simulation records the form, not an effect."],
    simulation: "Nine small thrust-led strokes with a thumb-forward turn on each thrust. A moderate stimulus that reads as reinforcing.",
  },
  xie: {
    group: "bu-xie", pinyin: "xie", name: "Reducing",
    aim: "Every contrast of lifting-thrusting and twirling taken the reducing way.",
    method: [
      "The needle is lifted quickly and firmly and thrust slowly and lightly, by a wide stroke, at a quick rhythm.",
      "With each lift the thumb goes back — a wider turn to the right — and is let back.",
      "Six times, and again. By the other single methods: in fast and out slowly, in on the in-breath, against the channel, and the hole rocked open.",
    ],
    formula: { zh: "紧提慢按，拇指向后；疾入徐出，吸进呼出，迎而夺之，摇大其孔", from: "单式补泻 (textbook summary)" },
    essentials: ["Wide stroke, wide arc, quick, longer.", "The force on the lift and on the thumb going back.", "Six — a yin number — twice."],
    cautions: ["Strong stimulation: watch the patient."],
    simulation: "Two sixes of wide lift-led strokes with a thumb-backward turn on each lift. A strong stimulus that reads as reducing.",
  },
};
