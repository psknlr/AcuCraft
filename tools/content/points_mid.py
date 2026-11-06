"""The Governor Vessel (GV) and Conception Vessel (CV) of the WHO standard (2008), and the 48 extra points of the WHO
standard nomenclature (1991). Rows as in points_arm.py; extra points carry their full code and optional extras.
"""

def _below(level, region):
    return f"In the {region}, in the depression inferior to the spinous process of {level}, on the posterior median line."

GV = [
  (1, "Chángqiáng", "长强", "Long Strong", "perineum", "In the perineal region, inferior to the coccyx, midway between the tip of the coccyx and the anus."),
  (2, "Yāoshū", "腰俞", "Lumbar Shu", "sacrum-buttock", "In the sacral region, at the sacral hiatus, on the posterior median line."),
  (3, "Yāoyángguān", "腰阳关", "Lumbar Yang Pass", "lower-back", _below("L4", "lumbar region")),
  (4, "Mìngmén", "命门", "Life Gate", "lower-back", _below("L2", "lumbar region")),
  (5, "Xuánshū", "悬枢", "Suspended Pivot", "lower-back", _below("L1", "lumbar region")),
  (6, "Jǐzhōng", "脊中", "Spinal Centre", "upper-back", _below("T11", "upper back")),
  (7, "Zhōngshū", "中枢", "Central Pivot", "upper-back", _below("T10", "upper back")),
  (8, "Jīnsuō", "筋缩", "Sinew Contraction", "upper-back", _below("T9", "upper back")),
  (9, "Zhìyáng", "至阳", "Reaching Yang", "upper-back", _below("T7", "upper back")),
  (10, "Língtái", "灵台", "Spirit Tower", "upper-back", _below("T6", "upper back")),
  (11, "Shéndào", "神道", "Spirit Path", "upper-back", _below("T5", "upper back")),
  (12, "Shēnzhù", "身柱", "Body Pillar", "upper-back", _below("T3", "upper back")),
  (13, "Táodào", "陶道", "Kiln Path", "upper-back", _below("T1", "upper back")),
  (14, "Dàzhuī", "大椎", "Great Hammer", "neck", _below("C7", "posterior region of the neck")),
  (15, "Yǎmén", "哑门", "Mute's Gate", "neck", "In the posterior region of the neck, in the depression superior to the spinous process of C2, on the posterior median line."),
  (16, "Fēngfǔ", "风府", "Wind Mansion", "neck", "In the posterior region of the neck, directly inferior to the external occipital protuberance, in the depression between the trapezius muscles."),
  (17, "Nǎohù", "脑户", "Brain's Door", "head", "On the head, in the depression superior to the external occipital protuberance."),
  (18, "Qiángjiān", "强间", "Unyielding Space", "head", "On the head, 4 B-cun superior to the posterior hairline, on the posterior median line."),
  (19, "Hòudǐng", "后顶", "Behind the Vertex", "head", "On the head, 5.5 B-cun superior to the posterior hairline, on the posterior median line."),
  (20, "Bǎihuì", "百会", "Hundred Convergences", "head", "On the head, 5 B-cun superior to the anterior hairline, on the anterior median line."),
  (21, "Qiándǐng", "前顶", "Before the Vertex", "head", "On the head, 3.5 B-cun superior to the anterior hairline, on the anterior median line."),
  (22, "Xìnhuì", "囟会", "Fontanel Meeting", "head", "On the head, 2 B-cun superior to the anterior hairline, on the anterior median line."),
  (23, "Shàngxīng", "上星", "Upper Star", "head", "On the head, 1 B-cun superior to the anterior hairline, on the anterior median line."),
  (24, "Shéntíng", "神庭", "Spirit Court", "head", "On the head, 0.5 B-cun superior to the anterior hairline, on the anterior median line."),
  (25, "Sùliáo", "素髎", "White Bone-Hole", "face", "On the face, at the tip of the nose."),
  (26, "Shuǐgōu", "水沟", "Water Trough", "face", "On the face, in the philtrum, at the junction of its upper third and lower two thirds (some standards place it at the midpoint of the philtrum)."),
  (27, "Duìduān", "兑端", "Extremity of the Mouth", "face", "On the face, at the midpoint of the tubercle of the upper lip."),
  (28, "Yínjiāo", "龈交", "Gum Intersection", "mouth", "Inside the upper lip, at the junction of the frenulum of the upper lip with the upper gum."),
]

def _cv(dist, where):
    part = "upper" if where == "superior" else "lower"
    return f"On the {part} abdomen, {dist} B-cun {where} to the centre of the umbilicus, on the anterior median line."

def _cvchest(n):
    return f"On the anterior thoracic region, at the level of the {n} intercostal space, on the anterior median line."

CV = [
  (1, "Huìyīn", "会阴", "Meeting of Yin", "perineum", "In the perineal region, at the midpoint between the anus and the posterior border of the scrotum (male) or the posterior labial commissure (female)."),
  (2, "Qūgǔ", "曲骨", "Curved Bone", "abdomen", "On the lower abdomen, superior to the pubic symphysis, on the anterior median line."),
  (3, "Zhōngjí", "中极", "Central Pole", "abdomen", _cv(4, "inferior")),
  (4, "Guānyuán", "关元", "Origin Pass", "abdomen", _cv(3, "inferior")),
  (5, "Shímén", "石门", "Stone Gate", "abdomen", _cv(2, "inferior")),
  (6, "Qìhǎi", "气海", "Sea of Qi", "abdomen", _cv(1.5, "inferior")),
  (7, "Yīnjiāo", "阴交", "Yin Intersection", "abdomen", _cv(1, "inferior")),
  (8, "Shénquè", "神阙", "Spirit Gate Tower", "abdomen", "On the abdomen, at the centre of the umbilicus."),
  (9, "Shuǐfēn", "水分", "Water Divide", "abdomen", _cv(1, "superior")),
  (10, "Xiàwǎn", "下脘", "Lower Stomach Duct", "abdomen", _cv(2, "superior")),
  (11, "Jiànlǐ", "建里", "Interior Strengthening", "abdomen", _cv(3, "superior")),
  (12, "Zhōngwǎn", "中脘", "Central Stomach Duct", "abdomen", _cv(4, "superior")),
  (13, "Shàngwǎn", "上脘", "Upper Stomach Duct", "abdomen", _cv(5, "superior")),
  (14, "Jùquè", "巨阙", "Great Tower Gate", "abdomen", _cv(6, "superior")),
  (15, "Jiūwěi", "鸠尾", "Turtledove Tail", "abdomen", "On the upper abdomen, 1 B-cun inferior to the xiphisternal junction, on the anterior median line."),
  (16, "Zhōngtíng", "中庭", "Central Courtyard", "chest", "On the anterior thoracic region, at the midpoint of the xiphisternal junction, on the anterior median line."),
  (17, "Dànzhōng", "膻中", "Chest Centre", "chest", _cvchest("fourth")),
  (18, "Yùtáng", "玉堂", "Jade Hall", "chest", _cvchest("third")),
  (19, "Zǐgōng", "紫宫", "Purple Palace", "chest", _cvchest("second")),
  (20, "Huágài", "华盖", "Florid Canopy", "chest", _cvchest("first")),
  (21, "Xuánjī", "璇玑", "Jade Pivot", "chest", "On the anterior thoracic region, 1 B-cun inferior to the suprasternal fossa, on the anterior median line."),
  (22, "Tiāntū", "天突", "Celestial Chimney", "neck", "In the anterior region of the neck, at the centre of the suprasternal fossa, on the anterior median line."),
  (23, "Liánquán", "廉泉", "Ridge Spring", "neck", "In the anterior region of the neck, superior to the superior border of the thyroid cartilage, in the depression superior to the hyoid bone, on the anterior median line."),
  (24, "Chéngjiāng", "承浆", "Sauce Receptacle", "face", "On the face, in the depression at the centre of the mentolabial sulcus."),
]

MID = {"GV": GV, "CV": CV}

# Extra points (WHO 1991 standard nomenclature): code, pinyin, hanzi, English, area, location, bilateral, sites
EX = [
  ("EX-HN1", "Sìshéncōng", "四神聪", "Four Alert Spirit", "head", "On the vertex, four points 1 B-cun anterior, posterior and lateral to GV20.", False, 4),
  ("EX-HN2", "Dāngyáng", "当阳", "Facing Yang", "head", "On the head, directly superior to the pupil, 1 B-cun superior to the anterior hairline.", True, None),
  ("EX-HN3", "Yìntáng", "印堂", "Hall of Impression", "head", "On the head, in the depression midway between the medial ends of the two eyebrows.", False, None),
  ("EX-HN4", "Yúyāo", "鱼腰", "Fish Waist", "head", "On the forehead, directly superior to the pupil, at the middle of the eyebrow.", True, None),
  ("EX-HN5", "Tàiyáng", "太阳", "Greater Yang", "head", "In the temporal region, in the depression about one finger-breadth posterior to the midpoint between the lateral end of the eyebrow and the outer canthus.", True, None),
  ("EX-HN6", "Ěrjiān", "耳尖", "Ear Apex", "head", "At the apex of the auricle, found with the ear folded forward.", True, None),
  ("EX-HN7", "Qiúhòu", "球后", "Behind the Ball", "face", "On the face, at the junction of the lateral quarter and medial three quarters of the infraorbital margin.", True, None),
  ("EX-HN8", "Shàngyíngxiāng", "上迎香", "Upper Welcome Fragrance", "face", "On the face, at the upper end of the nasolabial sulcus, at the junction of the alar cartilage and the nasal bone.", True, None),
  ("EX-HN9", "Nèiyíngxiāng", "内迎香", "Inner Welcome Fragrance", "face", "Inside the nostril, on the mucosa at the junction of the alar cartilage and the nasal concha.", True, None),
  ("EX-HN10", "Jùquán", "聚泉", "Gathering Spring", "mouth", "In the mouth, at the midpoint of the dorsal median line of the tongue.", False, None),
  ("EX-HN11", "Hǎiquán", "海泉", "Sea Spring", "mouth", "In the mouth, at the midpoint of the frenulum of the tongue.", False, None),
  ("EX-HN12", "Jīnjīn", "金津", "Golden Liquid", "mouth", "In the mouth, on the vein on the left side of the frenulum of the tongue.", False, None),
  ("EX-HN13", "Yùyè", "玉液", "Jade Humor", "mouth", "In the mouth, on the vein on the right side of the frenulum of the tongue.", False, None),
  ("EX-HN14", "Yìmíng", "翳明", "Shielding Brightness", "neck", "On the neck, 1 B-cun posterior to TE17.", True, None),
  ("EX-HN15", "Jǐngbǎiláo", "颈百劳", "Neck Hundred Taxations", "neck", "On the nape, 2 B-cun superior to the spinous process of C7, 1 B-cun lateral to the posterior median line.", True, None),
  ("EX-CA1", "Zǐgōng", "子宫", "Uterus", "abdomen", "On the lower abdomen, 4 B-cun inferior to the centre of the umbilicus, 3 B-cun lateral to the anterior median line.", True, None),
  ("EX-B1", "Dìngchuǎn", "定喘", "Stop Wheezing", "neck", "In the upper back, 0.5 B-cun lateral to the inferior border of the spinous process of C7.", True, None),
  ("EX-B2", "Jiájǐ", "夹脊", "Spine-Pinching Points", "upper-back", "On the back, 0.5 B-cun lateral to the inferior border of each spinous process from T1 to L5: seventeen points on each side.", True, 17),
  ("EX-B3", "Wèiwǎnxiàshū", "胃脘下俞", "Stomach Duct Lower Shu", "upper-back", "In the upper back, at the level of the inferior border of the spinous process of T8, 1.5 B-cun lateral to the posterior median line.", True, None),
  ("EX-B4", "Pǐgēn", "痞根", "Glomus Root", "lower-back", "In the lumbar region, at the level of the inferior border of the spinous process of L1, 3.5 B-cun lateral to the posterior median line.", True, None),
  ("EX-B5", "Xiàjíshū", "下极俞", "Lower Extremity Shu", "lower-back", "In the lumbar region, in the depression inferior to the spinous process of L3, on the posterior median line.", False, None),
  ("EX-B6", "Yāoyí", "腰宜", "Lumbar Appropriateness", "lower-back", "In the lumbar region, at the level of the inferior border of the spinous process of L4, 3 B-cun lateral to the posterior median line.", True, None),
  ("EX-B7", "Yāoyǎn", "腰眼", "Lumbar Eye", "lower-back", "In the lumbar region, in the depression at the level of the inferior border of the spinous process of L4, about 3.5 B-cun lateral to the posterior median line.", True, None),
  ("EX-B8", "Shíqīzhuī", "十七椎", "Seventeenth Vertebra", "lower-back", "In the lumbar region, in the depression inferior to the spinous process of L5, on the posterior median line.", False, None),
  ("EX-B9", "Yāoqí", "腰奇", "Lumbar Curiosity", "sacrum-buttock", "In the sacral region, 2 B-cun directly superior to the tip of the coccyx, in the depression between the sacral cornua.", False, None),
  ("EX-UE1", "Zhǒujiān", "肘尖", "Elbow Tip", "elbow", "On the posterior aspect of the elbow, at the tip of the olecranon (with the elbow flexed).", True, None),
  ("EX-UE2", "Èrbái", "二白", "Two Whites", "forearm", "On the anterior aspect of the forearm, 4 B-cun proximal to the palmar wrist crease, one point on each side of the flexor carpi radialis tendon.", True, 2),
  ("EX-UE3", "Zhōngquán", "中泉", "Central Spring", "wrist", "On the dorsal wrist crease, in the depression radial to the extensor digitorum tendon, between LI5 and TE4.", True, None),
  ("EX-UE4", "Zhōngkuí", "中魁", "Middle Eminence", "finger", "On the dorsal aspect of the middle finger, at the centre of the proximal interphalangeal joint.", True, None),
  ("EX-UE5", "Dàgǔkōng", "大骨空", "Great Bone Hollow", "finger", "On the dorsal aspect of the thumb, at the centre of the interphalangeal joint.", True, None),
  ("EX-UE6", "Xiǎogǔkōng", "小骨空", "Small Bone Hollow", "finger", "On the dorsal aspect of the little finger, at the centre of the proximal interphalangeal joint.", True, None),
  ("EX-UE7", "Yāotòngdiǎn", "腰痛点", "Lumbar Pain Points", "hand", "On the dorsum of the hand, between the second and third and between the fourth and fifth metacarpal bones, midway between the dorsal wrist crease and the metacarpophalangeal joints: two points on each hand.", True, 2),
  ("EX-UE8", "Wàiláogōng", "外劳宫", "Outer Palace of Toil", "hand", "On the dorsum of the hand, between the second and third metacarpal bones, about 0.5 B-cun proximal to the metacarpophalangeal joints.", True, None),
  ("EX-UE9", "Bāxié", "八邪", "Eight Pathogens", "hand", "On the dorsum of the hand, proximal to the margins of the webs between the five fingers, at the border between the red and white skin: four points on each hand.", True, 4),
  ("EX-UE10", "Sìfèng", "四缝", "Four Seams", "finger", "On the palmar aspect of the second to fifth fingers, at the centre of the crease of the proximal interphalangeal joint: four points on each hand.", True, 4),
  ("EX-UE11", "Shíxuān", "十宣", "Ten Diffusions", "finger", "At the tips of the ten fingers, about 0.1 F-cun from the free margin of the nail: five points on each hand.", True, 5),
  ("EX-LE1", "Kuāngǔ", "髋骨", "Hip Bone", "thigh", "On the anterior aspect of the thigh, 1.5 B-cun lateral and medial to ST34: two points on each leg.", True, 2),
  ("EX-LE2", "Hèdǐng", "鹤顶", "Crane's Summit", "knee", "Above the knee, in the depression at the midpoint of the superior border of the patella.", True, None),
  ("EX-LE3", "Bǎichóngwō", "百虫窝", "Hundred Insect Burrow", "thigh", "On the medial aspect of the thigh, 3 B-cun superior to the medial end of the base of the patella (1 B-cun superior to SP10).", True, None),
  ("EX-LE4", "Nèixīyǎn", "内膝眼", "Medial Knee Eye", "knee", "On the anterior aspect of the knee, in the depression medial to the patellar ligament (with the knee flexed).", True, None),
  ("EX-LE5", "Xīyǎn", "膝眼", "Knee Eyes", "knee", "On the anterior aspect of the knee, in the two depressions medial and lateral to the patellar ligament (with the knee flexed): the medial one is EX-LE4, the lateral one coincides with ST35.", True, 2),
  ("EX-LE6", "Dǎnnáng", "胆囊", "Gallbladder Point", "leg", "On the fibular aspect of the leg, 2 B-cun directly inferior to GB34.", True, None),
  ("EX-LE7", "Lánwěi", "阑尾", "Appendix Point", "leg", "On the anterior aspect of the leg, 2 B-cun inferior to ST36, one finger-breadth lateral to the anterior crest of the tibia.", True, None),
  ("EX-LE8", "Nèihuáijiān", "内踝尖", "Tip of the Medial Malleolus", "ankle", "On the medial aspect of the ankle, at the prominence of the medial malleolus.", True, None),
  ("EX-LE9", "Wàihuáijiān", "外踝尖", "Tip of the Lateral Malleolus", "ankle", "On the lateral aspect of the ankle, at the prominence of the lateral malleolus.", True, None),
  ("EX-LE10", "Bāfēng", "八风", "Eight Winds", "foot", "On the dorsum of the foot, proximal to the margins of the webs between the five toes, at the border between the red and white skin: four points on each foot.", True, 4),
  ("EX-LE11", "Dúyīn", "独阴", "Solitary Yin", "toe", "On the plantar aspect of the second toe, at the centre of the crease of the distal interphalangeal joint.", True, None),
  ("EX-LE12", "Qìduān", "气端", "Qi Extremity", "toe", "At the tips of the ten toes, about 0.1 F-cun from the free margin of the nail: five points on each foot.", True, 5),
]
