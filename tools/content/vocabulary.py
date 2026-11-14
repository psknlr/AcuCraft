"""The assessment vocabulary of the Singapore pack (authoring script; the JSON it writes is the content).

Writes content/sg/vocabulary.json (acucraft/vocabulary@1): diagnoses, red flags, and what links the two TCM
constructs of an encounter to evidence —

  * signs, and for each pattern the signs it is recognised by (`criteria`: key, supporting, against). A pattern
    differentiation cites the findings it rests on; which finding of a case shows which sign is the scenario's own
    hidden interpretation (`evaluation.signs` in a family's field);
  * needle sensations and which of them are deqi, with what counts as evidence of deqi.

Everything here is an unreviewed, AI-assisted paraphrase of general textbook teaching: review it with a bilingual TCM
educator before any teaching use.

    python3 tools/content/vocabulary.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import ROOT, dump

def S(id, label, zh, method):
    return {"id": id, "label": label, "zh": zh, "method": method}

SIGNS = [
    # inquiry: the pain
    S("pain-worse-cold-damp", "Pain worse in cold or damp weather", "遇寒湿加重", "inquiry"),
    S("pain-better-warmth", "Pain eased by warmth", "得温痛减", "inquiry"),
    S("heaviness", "Heaviness of the limb or the body", "重着", "inquiry"),
    S("pain-fixed", "Pain fixed in one place", "痛处固定", "inquiry"),
    S("pain-stabbing", "Stabbing or boring pain", "刺痛", "inquiry"),
    S("pain-worse-night", "Pain worse at night", "夜间痛甚", "inquiry"),
    S("pain-distending-pressing", "Distending or pressing pain, like a tight band", "胀痛", "inquiry"),
    S("pain-worse-inactivity", "Worse with staying still, eased by moving about", "久坐加重、活动后减轻", "inquiry"),
    S("pain-worse-exertion", "A dull ache brought on by use and eased by rest", "劳则加重、休息后减轻", "inquiry"),
    S("chronic-course", "A long, lingering course", "病程日久", "inquiry"),
    S("recent-onset", "Recent onset after exposure to wind or cold", "新感风寒", "inquiry"),
    S("stiffness", "Stiffness, worse after rest", "僵硬、屈伸不利", "inquiry"),
    S("joint-hot-red-swollen", "A hot, red, swollen joint", "关节红肿热痛", "inspection"),
    S("weak-knees-back", "Weak or sore lower back and knees", "腰膝酸软", "inquiry"),
    # inquiry: the whole person
    S("aversion-to-cold", "Feels the cold (aversion to cold)", "畏寒", "inquiry"),
    S("cold-limbs", "Cold limbs", "肢冷", "inquiry"),
    S("fever", "Fever or feeling feverish", "发热", "inquiry"),
    S("thirst", "Thirst", "口渴", "inquiry"),
    S("fatigue", "Tiredness, easily fatigued", "神疲乏力", "inquiry"),
    S("poor-appetite", "Poor appetite", "纳呆", "inquiry"),
    S("loose-stools", "Loose stools", "便溏", "inquiry"),
    S("nausea-vomiting", "Nausea or vomiting", "恶心呕吐", "inquiry"),
    S("belching", "Belching or hiccup", "嗳气呃逆", "inquiry"),
    S("chest-epigastric-fullness", "Fullness of the chest or epigastrium", "胸脘痞闷", "inquiry"),
    S("phlegm", "Copious phlegm", "痰多", "inquiry"),
    S("emotional-strain", "Brought on or made worse by stress and emotional strain", "情志不遂", "inquiry"),
    S("irritability", "Irritability", "急躁易怒", "inquiry"),
    S("sighing", "Frequent sighing", "善太息", "inquiry"),
    S("worry", "Worry and overthinking", "思虑过度", "inquiry"),
    S("dizziness", "Dizziness", "头晕", "inquiry"),
    S("tinnitus", "Tinnitus", "耳鸣", "inquiry"),
    S("insomnia", "Difficulty falling or staying asleep", "不寐", "inquiry"),
    S("light-sleep", "Light, easily disturbed sleep", "眠浅易醒", "inquiry"),
    S("dream-disturbed-sleep", "Dream-disturbed sleep", "多梦", "inquiry"),
    S("palpitations", "Palpitations", "心悸", "inquiry"),
    S("poor-memory", "Poor memory", "健忘", "inquiry"),
    S("night-sweats", "Night sweats", "盗汗", "inquiry"),
    S("five-palm-heat", "Heat in the palms, soles and chest", "五心烦热", "inquiry"),
    S("dry-mouth", "Dry mouth and throat, worse at night", "口干咽燥", "inquiry"),
    S("frequent-pale-urination", "Frequent, pale urination", "小便清长", "inquiry"),
    S("chills", "Chills", "恶寒", "inquiry"),
    S("occipital-stiff-neck", "Occipital headache with a stiff neck", "头项强痛", "inquiry"),
    # inspection and palpation
    S("red-face-eyes", "Red face or eyes", "面红目赤", "inspection"),
    S("tired-appearance", "Looks tired", "神疲", "inspection"),
    S("bony-enlargement", "Bony enlargement or deformity of a joint", "关节变形", "inspection"),
    S("tender-point", "Tenderness maximal at one fixed point", "压痛固定", "palpation"),
    S("muscle-tension", "Tight, tender muscles", "筋肉拘急", "palpation"),
    # tongue
    S("tongue-pale", "Pale tongue", "舌淡", "tongue"),
    S("tongue-red", "Red tongue", "舌红", "tongue"),
    S("tongue-red-edges", "Red edges of the tongue", "舌边红", "tongue"),
    S("tongue-purple", "Purple tongue or purple spots", "舌紫暗或有瘀斑", "tongue"),
    S("tongue-swollen-toothmarked", "Swollen tongue with teeth marks", "舌胖有齿痕", "tongue"),
    S("coat-thin-white", "Thin white coat", "苔薄白", "tongue"),
    S("coat-white-greasy", "White greasy coat", "苔白腻", "tongue"),
    S("coat-yellow-greasy", "Yellow greasy coat", "苔黄腻", "tongue"),
    S("coat-scanty", "Little or no coat", "少苔", "tongue"),
    # pulse
    S("pulse-deep", "Deep pulse", "脉沉", "pulse"),
    S("pulse-slow", "Slow pulse", "脉迟", "pulse"),
    S("pulse-rapid", "Rapid pulse", "脉数", "pulse"),
    S("pulse-slippery", "Slippery pulse", "脉滑", "pulse"),
    S("pulse-wiry", "Wiry pulse", "脉弦", "pulse"),
    S("pulse-choppy", "Choppy pulse", "脉涩", "pulse"),
    S("pulse-weak", "Weak pulse", "脉弱", "pulse"),
    S("pulse-thin", "Thin pulse", "脉细", "pulse"),
    S("pulse-floating", "Floating pulse", "脉浮", "pulse"),
    S("pulse-tight", "Tight pulse", "脉紧", "pulse"),
]

def P(id, label, zh, key, supporting, against=()):
    return {"id": id, "label": label, "zh": zh, "criteria": {"key": list(key), "supporting": list(supporting), "against": list(against)}}

PATTERNS = [
    P("wind-cold-damp-bi", "Wind-cold-damp painful obstruction (Bi)", "风寒湿痹",
      key=["pain-worse-cold-damp", "pain-better-warmth", "heaviness"],
      supporting=["aversion-to-cold", "stiffness", "tongue-pale", "coat-thin-white", "coat-white-greasy", "pulse-deep", "pulse-slow", "pulse-slippery", "pulse-wiry", "pulse-tight"],
      against=["joint-hot-red-swollen", "fever", "thirst", "tongue-red", "coat-yellow-greasy", "pulse-rapid"]),
    P("damp-heat-bi", "Damp-heat painful obstruction (Bi)", "湿热痹",
      key=["joint-hot-red-swollen", "fever"],
      supporting=["thirst", "heaviness", "tongue-red", "coat-yellow-greasy", "pulse-rapid", "pulse-slippery"],
      against=["pain-better-warmth", "pain-worse-cold-damp", "aversion-to-cold", "tongue-pale", "pulse-slow"]),
    P("qi-blood-stagnation", "Qi and blood stagnation", "气滞血瘀",
      key=["pain-fixed", "pain-stabbing", "pain-worse-night", "tender-point"],
      supporting=["chronic-course", "pain-worse-inactivity", "muscle-tension", "emotional-strain", "tongue-purple", "pulse-wiry", "pulse-choppy"]),
    P("liver-kidney-deficiency", "Liver and kidney deficiency", "肝肾亏虚",
      key=["weak-knees-back", "pain-worse-exertion", "chronic-course"],
      supporting=["bony-enlargement", "stiffness", "dizziness", "tinnitus", "fatigue", "tongue-pale", "coat-scanty", "pulse-deep", "pulse-thin", "pulse-weak"],
      against=["joint-hot-red-swollen", "fever"]),
    P("kidney-yang-deficiency", "Kidney yang deficiency", "肾阳虚",
      key=["weak-knees-back", "aversion-to-cold", "cold-limbs"],
      supporting=["fatigue", "pain-better-warmth", "frequent-pale-urination", "tongue-pale", "tongue-swollen-toothmarked", "pulse-deep", "pulse-weak", "pulse-slow"],
      against=["tongue-red", "pulse-rapid", "night-sweats", "five-palm-heat"]),
    P("liver-yang-rising", "Ascendant liver yang", "肝阳上亢",
      key=["irritability", "dizziness", "red-face-eyes"],
      supporting=["pain-distending-pressing", "tinnitus", "light-sleep", "insomnia", "emotional-strain", "tongue-red", "tongue-red-edges", "pulse-wiry", "pulse-rapid"],
      against=["aversion-to-cold", "tongue-pale", "pulse-slow", "pulse-weak"]),
    P("liver-qi-stagnation", "Liver qi stagnation", "肝气郁结",
      key=["emotional-strain", "irritability", "pain-distending-pressing", "sighing"],
      supporting=["muscle-tension", "light-sleep", "chest-epigastric-fullness", "coat-thin-white", "pulse-wiry"]),
    P("wind-cold-invasion", "External wind-cold", "风寒外袭",
      key=["recent-onset", "chills", "occipital-stiff-neck"],
      supporting=["aversion-to-cold", "coat-thin-white", "pulse-floating", "pulse-tight"],
      against=["chronic-course", "tongue-red", "coat-yellow-greasy"]),
    P("spleen-stomach-deficiency", "Spleen and stomach deficiency", "脾胃虚弱",
      key=["poor-appetite", "fatigue", "loose-stools"],
      supporting=["nausea-vomiting", "tired-appearance", "tongue-pale", "tongue-swollen-toothmarked", "coat-thin-white", "pulse-weak"],
      against=["coat-yellow-greasy", "tongue-red", "pulse-rapid"]),
    P("stomach-qi-rebellion", "Rebellious stomach qi", "胃气上逆",
      key=["nausea-vomiting", "belching"],
      supporting=["poor-appetite", "chest-epigastric-fullness", "pulse-slippery", "coat-thin-white", "coat-white-greasy"]),
    P("phlegm-damp", "Phlegm-damp", "痰湿",
      key=["heaviness", "chest-epigastric-fullness", "phlegm"],
      supporting=["nausea-vomiting", "dizziness", "tongue-swollen-toothmarked", "coat-white-greasy", "pulse-slippery"],
      against=["tongue-red", "coat-scanty", "pulse-thin"]),
    P("heart-spleen-deficiency", "Heart and spleen deficiency", "心脾两虚",
      key=["insomnia", "dream-disturbed-sleep", "palpitations", "poor-appetite", "fatigue"],
      supporting=["worry", "poor-memory", "loose-stools", "tired-appearance", "tongue-pale", "tongue-swollen-toothmarked", "coat-thin-white", "pulse-thin", "pulse-weak"],
      against=["tongue-red", "pulse-rapid", "night-sweats", "five-palm-heat"]),
    P("heart-kidney-disharmony", "Disharmony of heart and kidney", "心肾不交",
      key=["insomnia", "palpitations", "night-sweats", "five-palm-heat"],
      supporting=["dream-disturbed-sleep", "dizziness", "tinnitus", "poor-memory", "weak-knees-back", "dry-mouth", "tongue-red", "coat-scanty", "pulse-thin", "pulse-rapid"],
      against=["tongue-pale", "tongue-swollen-toothmarked", "aversion-to-cold"]),
]

def src(title, publisher, published, url=None, locator=None, verified=False, note=None):
    o = {"title": title, "publisher": publisher, "publishedAt": published, "verified": verified}
    if url: o["url"] = url
    if locator: o["locator"] = locator
    if note: o["note"] = note
    return o

WHO_IST = src("WHO international standard terminologies on traditional Chinese medicine", "World Health Organization", "2022",
              url="https://www.who.int/publications/i/item/9789240042322",
              note="The publication (ISBN 9789240042322) was confirmed to exist; its entries for these patterns, their manifestations and deqi were not read while this pack was written. The criteria here are a paraphrase of general textbook teaching, not the standard's text.")
ICD11 = src("ICD-11, Supplementary Chapter Traditional Medicine Conditions – Module I", "World Health Organization", "2019 (in effect 2022)",
            note="Cited as the classification that names traditional medicine patterns; not consulted for the criteria, which it does not define.")
GBT = src("GB/T 16751.2-2021 Clinic terminology of traditional Chinese medical diagnosis and treatment — Part 2: Syndromes/patterns", "Standardization Administration of China", "2021",
          note="Recalled, not retrieved: confirm the title, the edition and each pattern's wording before use.")

VOCABULARY = {
    "schema": "acucraft/vocabulary@1", "id": "sg-tcm", "version": "0.2.0",
    "review": {"status": "unreviewed", "reviewers": [], "notes": "Terminology for structured assessment. Mandarin names, the signs and each pattern's criteria are AI-assisted paraphrases of general textbook teaching and need review by a bilingual TCM educator; a pattern's criteria are a teaching simplification, not a validated diagnostic rule."},
    "diagnoses": [
        {"id": "knee-osteoarthritis", "label": "Knee osteoarthritis"}, {"id": "septic-arthritis", "label": "Septic arthritis (suspected)"}, {"id": "crystal-arthritis", "label": "Gout or pseudogout flare"},
        {"id": "meniscal-injury", "label": "Meniscal injury"}, {"id": "inflammatory-arthritis", "label": "Inflammatory arthritis"}, {"id": "chronic-nonspecific-lbp", "label": "Chronic non-specific low back pain"},
        {"id": "lumbar-radiculopathy", "label": "Lumbar radiculopathy"}, {"id": "cauda-equina-syndrome", "label": "Cauda equina syndrome (suspected)"}, {"id": "pregnancy-related-lbp", "label": "Pregnancy-related low back / pelvic girdle pain"},
        {"id": "tension-type-headache", "label": "Tension-type headache"}, {"id": "migraine", "label": "Migraine"}, {"id": "secondary-headache", "label": "Secondary headache (suspected)"},
        {"id": "cervicogenic-headache", "label": "Cervicogenic headache"}, {"id": "chemotherapy-nausea", "label": "Chemotherapy-induced nausea and vomiting"}, {"id": "neutropenia", "label": "Neutropenia"},
        {"id": "lymphoedema", "label": "Lymphoedema"}, {"id": "vasovagal-reaction", "label": "Vasovagal reaction"}, {"id": "depressive-episode", "label": "Depressive episode"}, {"id": "insomnia", "label": "Insomnia"},
    ],
    "signs": SIGNS,
    "patterns": PATTERNS,
    "differentiation": {
        "key": 1, "total": 3, "against": 2,
        "note": "A pattern differentiation names the findings it rests on. It rests on its evidence when those findings show at least one of the pattern's key signs and three of its signs in all (key or supporting), and the findings obtained do not show two signs that speak against it. A biomedical diagnosis never implies one pattern, and one sign never makes one.",
        "sources": [WHO_IST, ICD11, GBT],
    },
    "sensations": [
        {"id": "aching", "label": "Soreness or a dull ache", "zh": "酸", "deqi": True},
        {"id": "numbness", "label": "Numbness or tingling", "zh": "麻", "deqi": True},
        {"id": "heaviness", "label": "Heaviness", "zh": "重", "deqi": True},
        {"id": "distension", "label": "Distension or fullness", "zh": "胀", "deqi": True},
        {"id": "warmth", "label": "Warmth", "zh": "热", "deqi": True},
        {"id": "spreading", "label": "A sensation spreading from the needle", "zh": "感传", "deqi": True},
        {"id": "sharp-pain", "label": "Sharp pain", "zh": "锐痛", "deqi": False},
        {"id": "burning", "label": "Burning", "zh": "灼痛", "deqi": False},
        {"id": "electric", "label": "An electric, shooting sensation", "zh": "触电感", "deqi": False},
    ],
    "deqi": {
        "definition": "Deqi (得气, the arrival of qi): the response to a needle at an effective depth. The patient feels soreness, numbness, heaviness or distension at the needle, sometimes spreading from it; the practitioner feels the needle become heavy and tight in the tissue, as if gripped. Sharp, burning or electric sensations are not deqi: they are reasons to adjust or withdraw the needle.",
        "evidence": "A recorded deqi response rests on what was observed at that needle: what the patient said they felt when asked, or the grip the practitioner felt on manipulating it. Inserting or manipulating a needle is not evidence that deqi arrived, a response is recorded needle by needle, and stronger stimulation is never the aim.",
        "sources": [
            src("Revised STandards for Reporting Interventions in Clinical Trials of Acupuncture (STRICTA): extending the CONSORT statement", "MacPherson H, Altman DG, Hammerschlag R, et al. PLoS Medicine 7(6): e1000261", "2010",
                url="https://pmc.ncbi.nlm.nih.gov/articles/PMC2882429", locator="Item 2d: Response sought (e.g. de qi or muscle twitch response)", verified=True,
                note="The item's wording was checked against the published checklist while this pack was written. STRICTA is a reporting standard: it asks that the response sought be reported, not that deqi be obtained."),
            src("Acupuncture de qi, from qualitative history to quantitative measurement", "Kong J, Gollub R, Huang T, et al. Journal of Alternative and Complementary Medicine 13(10): 1059-1070", "2007",
                note="The paper and its sensation scale (the MGH Acupuncture Sensation Scale) were confirmed to exist; the descriptors here follow later reviews of the scale, which also report that sharp pain is not commonly regarded as deqi. The full text was not read: check it before use."),
            WHO_IST,
        ],
    },
    "redFlags": [
        {"id": "hot-swollen-joint-fever", "label": "Hot, swollen joint with fever"}, {"id": "unable-to-bear-weight", "label": "Unable to bear weight"}, {"id": "saddle-anaesthesia", "label": "Saddle anaesthesia"},
        {"id": "bladder-bowel-dysfunction", "label": "New bladder or bowel dysfunction"}, {"id": "progressive-neuro-deficit", "label": "Progressive neurological deficit"}, {"id": "thunderclap-headache", "label": "Sudden, severe (thunderclap) headache"},
        {"id": "new-headache-over-50", "label": "New headache after 50"}, {"id": "headache-neuro-signs", "label": "Headache with neurological signs"}, {"id": "fever-on-chemotherapy", "label": "Fever or neutropenia during chemotherapy"},
        {"id": "unexplained-weight-loss", "label": "Unexplained weight loss"}, {"id": "night-pain", "label": "Constant or night pain"}, {"id": "trauma", "label": "Significant trauma"}, {"id": "suicidal-ideation", "label": "Thoughts of self-harm or suicide"},
    ],
}

if __name__ == "__main__":
    ids = {s["id"] for s in SIGNS}
    for p in PATTERNS:
        for kind in ("key", "supporting", "against"):
            for sign in p["criteria"][kind]:
                assert sign in ids, f"{p['id']}: unknown sign {sign}"
    used = {s for p in PATTERNS for kind in ("key", "supporting", "against") for s in p["criteria"][kind]}
    dump(os.path.join(ROOT, "content", "sg", "vocabulary.json"), VOCABULARY)
    print(f"{len(SIGNS)} signs ({len(ids - used)} not used by a pattern: {sorted(ids - used)}), {len(PATTERNS)} patterns")
