"""The six arm channels of the WHO standard (2008): LU, LI, HT, SI, PC, TE.

Each row: number, pinyin, hanzi, English name, body area, location (paraphrased, B-cun = proportional bone cun,
F-cun = finger cun). Locations are paraphrases for orientation and lookup; they are not the standard's text and
must be checked against it.
"""

LU = [
  (1, "Zhōngfǔ", "中府", "Central Treasury", "chest", "On the anterior thoracic region, at the level of the first intercostal space, lateral to the infraclavicular fossa, 6 B-cun lateral to the anterior median line."),
  (2, "Yúnmén", "云门", "Cloud Gate", "chest", "On the anterior thoracic region, in the depression of the infraclavicular fossa, medial to the coracoid process, 6 B-cun lateral to the anterior median line."),
  (3, "Tiānfǔ", "天府", "Celestial Storehouse", "upper-arm", "On the anterolateral aspect of the arm, just lateral to the border of the biceps brachii, 3 B-cun inferior to the anterior end of the axillary fold."),
  (4, "Xiábái", "侠白", "Guarding White", "upper-arm", "On the anterolateral aspect of the arm, just lateral to the border of the biceps brachii, 4 B-cun inferior to the anterior end of the axillary fold."),
  (5, "Chǐzé", "尺泽", "Cubit Marsh", "elbow", "On the anterior aspect of the elbow, at the cubital crease, in the depression lateral to the biceps brachii tendon."),
  (6, "Kǒngzuì", "孔最", "Collection Hole", "forearm", "On the anterolateral aspect of the forearm, on the line connecting LU5 with LU9, 7 B-cun superior to the palmar wrist crease."),
  (7, "Lièquē", "列缺", "Broken Sequence", "forearm", "On the radial aspect of the forearm, between the tendons of abductor pollicis longus and extensor pollicis brevis, in the groove for the abductor pollicis longus tendon, 1.5 B-cun superior to the palmar wrist crease."),
  (8, "Jīngqú", "经渠", "Channel Ditch", "forearm", "On the anterolateral aspect of the forearm, between the radial styloid process and the radial artery, 1 B-cun superior to the palmar wrist crease."),
  (9, "Tàiyuān", "太渊", "Great Abyss", "wrist", "On the anterolateral aspect of the wrist, between the radial styloid process and the scaphoid bone, in the depression ulnar to the abductor pollicis longus tendon."),
  (10, "Yújì", "鱼际", "Fish Border", "hand", "On the palm, radial to the midpoint of the first metacarpal bone, at the border between the red and white skin."),
  (11, "Shàoshāng", "少商", "Lesser Shang", "finger", "On the thumb, radial to the distal phalanx, 0.1 F-cun proximal-lateral to the radial corner of the thumbnail."),
]

LI = [
  (1, "Shāngyáng", "商阳", "Shang Yang", "finger", "On the index finger, radial to the distal phalanx, 0.1 F-cun proximal-lateral to the radial corner of the fingernail."),
  (2, "Èrjiān", "二间", "Second Space", "finger", "On the index finger, in the depression distal to the radial side of the second metacarpophalangeal joint, at the border between the red and white skin."),
  (3, "Sānjiān", "三间", "Third Space", "hand", "On the dorsum of the hand, in the depression radial and proximal to the second metacarpophalangeal joint."),
  (4, "Hégǔ", "合谷", "Union Valley", "hand", "On the dorsum of the hand, radial to the midpoint of the second metacarpal bone."),
  (5, "Yángxī", "阳溪", "Yang Ravine", "wrist", "On the posterolateral aspect of the wrist, at the radial side of the dorsal wrist crease, distal to the radial styloid process, in the depression of the anatomical snuffbox."),
  (6, "Piānlì", "偏历", "Veering Passageway", "forearm", "On the posterolateral aspect of the forearm, on the line connecting LI5 with LI11, 3 B-cun superior to the dorsal wrist crease."),
  (7, "Wēnliū", "温溜", "Warm Dwelling", "forearm", "On the posterolateral aspect of the forearm, on the line connecting LI5 with LI11, 5 B-cun superior to the dorsal wrist crease."),
  (8, "Xiàlián", "下廉", "Lower Ridge", "forearm", "On the posterolateral aspect of the forearm, on the line connecting LI5 with LI11, 4 B-cun inferior to the cubital crease."),
  (9, "Shànglián", "上廉", "Upper Ridge", "forearm", "On the posterolateral aspect of the forearm, on the line connecting LI5 with LI11, 3 B-cun inferior to the cubital crease."),
  (10, "Shǒusānlǐ", "手三里", "Arm Three Li", "forearm", "On the posterolateral aspect of the forearm, on the line connecting LI5 with LI11, 2 B-cun inferior to the cubital crease."),
  (11, "Qūchí", "曲池", "Pool at the Bend", "elbow", "On the lateral aspect of the elbow, at the midpoint of the line connecting LU5 with the lateral epicondyle of the humerus."),
  (12, "Zhǒuliáo", "肘髎", "Elbow Bone-Hole", "elbow", "On the posterolateral aspect of the elbow, superior to the lateral epicondyle of the humerus, anterior to the lateral supracondylar ridge."),
  (13, "Shǒuwǔlǐ", "手五里", "Arm Five Li", "upper-arm", "On the lateral aspect of the arm, on the line connecting LI11 with LI15, 3 B-cun superior to the cubital crease."),
  (14, "Bìnào", "臂臑", "Upper Arm", "upper-arm", "On the lateral aspect of the arm, just anterior to the border of the deltoid muscle, 7 B-cun superior to LI11."),
  (15, "Jiānyú", "肩髃", "Shoulder Bone", "shoulder", "In the shoulder girdle region, in the depression between the anterior end of the lateral border of the acromion and the greater tubercle of the humerus."),
  (16, "Jùgǔ", "巨骨", "Great Bone", "shoulder", "In the shoulder girdle region, in the depression between the acromial end of the clavicle and the spine of the scapula."),
  (17, "Tiāndǐng", "天鼎", "Celestial Tripod", "neck", "In the anterior region of the neck, at the level of the cricoid cartilage, just posterior to the posterior border of the sternocleidomastoid muscle."),
  (18, "Fútū", "扶突", "Protuberance Assistant", "neck", "In the anterior region of the neck, at the level of the superior border of the thyroid cartilage, between the anterior and posterior borders of the sternocleidomastoid muscle."),
  (19, "Kǒuhéliáo", "口禾髎", "Grain Bone-Hole", "face", "On the face, at the level of the junction of the upper third and lower two thirds of the philtrum, inferior to the lateral margin of the nostril."),
  (20, "Yíngxiāng", "迎香", "Welcome Fragrance", "face", "On the face, in the nasolabial sulcus, at the level of the midpoint of the lateral border of the ala of the nose."),
]

HT = [
  (1, "Jíquán", "极泉", "Highest Spring", "axilla", "In the axilla, at the centre of the axillary fossa, over the axillary artery."),
  (2, "Qīnglíng", "青灵", "Cyan Spirit", "upper-arm", "On the medial aspect of the arm, just medial to the biceps brachii, 3 B-cun superior to the cubital crease."),
  (3, "Shàohǎi", "少海", "Lesser Sea", "elbow", "On the anteromedial aspect of the elbow, just anterior to the medial epicondyle of the humerus, at the level of the cubital crease."),
  (4, "Língdào", "灵道", "Spirit Path", "forearm", "On the anteromedial aspect of the forearm, just radial to the flexor carpi ulnaris tendon, 1.5 B-cun proximal to the palmar wrist crease."),
  (5, "Tōnglǐ", "通里", "Connecting Li", "forearm", "On the anteromedial aspect of the forearm, just radial to the flexor carpi ulnaris tendon, 1 B-cun proximal to the palmar wrist crease."),
  (6, "Yīnxì", "阴郄", "Yin Cleft", "forearm", "On the anteromedial aspect of the forearm, just radial to the flexor carpi ulnaris tendon, 0.5 B-cun proximal to the palmar wrist crease."),
  (7, "Shénmén", "神门", "Spirit Gate", "wrist", "On the anteromedial aspect of the wrist, radial to the flexor carpi ulnaris tendon, on the palmar wrist crease."),
  (8, "Shàofǔ", "少府", "Lesser Mansion", "hand", "On the palm, in the depression between the fourth and fifth metacarpal bones, proximal to the fifth metacarpophalangeal joint."),
  (9, "Shàochōng", "少冲", "Lesser Surge", "finger", "On the little finger, radial to the distal phalanx, 0.1 F-cun proximal-lateral to the radial corner of the fingernail."),
]

SI = [
  (1, "Shàozé", "少泽", "Lesser Marsh", "finger", "On the little finger, ulnar to the distal phalanx, 0.1 F-cun proximal-medial to the ulnar corner of the fingernail."),
  (2, "Qiángǔ", "前谷", "Front Valley", "finger", "On the little finger, in the depression distal to the ulnar side of the fifth metacarpophalangeal joint, at the border between the red and white skin."),
  (3, "Hòuxī", "后溪", "Back Ravine", "hand", "On the dorsum of the hand, in the depression proximal to the ulnar side of the fifth metacarpophalangeal joint, at the border between the red and white skin."),
  (4, "Wàngǔ", "腕骨", "Wrist Bone", "wrist", "On the posteromedial aspect of the wrist, in the depression between the base of the fifth metacarpal bone and the triquetrum, at the border between the red and white skin."),
  (5, "Yánggǔ", "阳谷", "Yang Valley", "wrist", "On the posteromedial aspect of the wrist, in the depression between the triquetrum and the ulnar styloid process."),
  (6, "Yǎnglǎo", "养老", "Nursing the Aged", "forearm", "On the posteromedial aspect of the forearm, in the depression radial to the head of the ulna, 1 B-cun proximal to the dorsal wrist crease."),
  (7, "Zhīzhèng", "支正", "Branch to the Correct", "forearm", "On the posteromedial aspect of the forearm, between the medial border of the ulna and the flexor carpi ulnaris muscle, 5 B-cun proximal to the dorsal wrist crease."),
  (8, "Xiǎohǎi", "小海", "Small Sea", "elbow", "On the posteromedial aspect of the elbow, in the depression between the olecranon and the medial epicondyle of the humerus."),
  (9, "Jiānzhēn", "肩贞", "True Shoulder", "shoulder", "In the shoulder girdle region, posteroinferior to the shoulder joint, 1 B-cun superior to the posterior axillary fold."),
  (10, "Nàoshū", "臑俞", "Upper Arm Shu", "shoulder", "In the shoulder girdle region, superior to the end of the posterior axillary fold, in the depression inferior to the spine of the scapula."),
  (11, "Tiānzōng", "天宗", "Celestial Gathering", "upper-back", "In the scapular region, in the depression at the junction of the upper third and lower two thirds of the line connecting the midpoint of the spine of the scapula with the inferior angle of the scapula."),
  (12, "Bǐngfēng", "秉风", "Grasping the Wind", "upper-back", "In the scapular region, in the supraspinous fossa, superior to the midpoint of the spine of the scapula."),
  (13, "Qūyuán", "曲垣", "Crooked Wall", "upper-back", "In the scapular region, in the depression superior to the medial end of the spine of the scapula."),
  (14, "Jiānwàishū", "肩外俞", "Outer Shoulder Shu", "upper-back", "In the upper back, at the level of the inferior border of the spinous process of T1, 3 B-cun lateral to the posterior median line."),
  (15, "Jiānzhōngshū", "肩中俞", "Central Shoulder Shu", "upper-back", "In the upper back, at the level of the inferior border of the spinous process of C7, 2 B-cun lateral to the posterior median line."),
  (16, "Tiānchuāng", "天窗", "Celestial Window", "neck", "In the anterior region of the neck, at the level of the superior border of the thyroid cartilage, posterior to the sternocleidomastoid muscle."),
  (17, "Tiānróng", "天容", "Celestial Countenance", "neck", "In the anterior region of the neck, posterior to the angle of the mandible, in the depression anterior to the sternocleidomastoid muscle."),
  (18, "Quánliáo", "颧髎", "Cheek Bone-Hole", "face", "On the face, inferior to the zygomatic bone, in the depression directly inferior to the outer canthus of the eye."),
  (19, "Tīnggōng", "听宫", "Palace of Hearing", "face", "On the face, in the depression between the anterior border of the centre of the tragus and the posterior border of the condylar process of the mandible (with the mouth open)."),
]

PC = [
  (1, "Tiānchí", "天池", "Celestial Pool", "chest", "On the anterior thoracic region, in the fourth intercostal space, 5 B-cun lateral to the anterior median line."),
  (2, "Tiānquán", "天泉", "Celestial Spring", "upper-arm", "On the anterior aspect of the arm, between the long and short heads of the biceps brachii, 2 B-cun inferior to the anterior axillary fold."),
  (3, "Qūzé", "曲泽", "Marsh at the Bend", "elbow", "On the anterior aspect of the elbow, at the cubital crease, in the depression medial to the biceps brachii tendon."),
  (4, "Xìmén", "郄门", "Cleft Gate", "forearm", "On the anterior aspect of the forearm, between the tendons of palmaris longus and flexor carpi radialis, 5 B-cun proximal to the palmar wrist crease."),
  (5, "Jiānshǐ", "间使", "Intermediary Courier", "forearm", "On the anterior aspect of the forearm, between the tendons of palmaris longus and flexor carpi radialis, 3 B-cun proximal to the palmar wrist crease."),
  (6, "Nèiguān", "内关", "Inner Pass", "forearm", "On the anterior aspect of the forearm, between the tendons of palmaris longus and flexor carpi radialis, 2 B-cun proximal to the palmar wrist crease."),
  (7, "Dàlíng", "大陵", "Great Mound", "wrist", "On the anterior aspect of the wrist, between the tendons of palmaris longus and flexor carpi radialis, on the palmar wrist crease."),
  (8, "Láogōng", "劳宫", "Palace of Toil", "hand", "On the palm, in the depression between the second and third metacarpal bones, proximal to the metacarpophalangeal joints (some traditions locate it between the third and fourth metacarpal bones)."),
  (9, "Zhōngchōng", "中冲", "Central Hub", "finger", "At the centre of the tip of the middle finger (some traditions locate it 0.1 F-cun from the radial corner of the nail)."),
]

TE = [
  (1, "Guānchōng", "关冲", "Passage Hub", "finger", "On the ring finger, ulnar to the distal phalanx, 0.1 F-cun proximal-medial to the ulnar corner of the fingernail."),
  (2, "Yèmén", "液门", "Humor Gate", "hand", "On the dorsum of the hand, in the depression proximal to the web margin between the ring and little fingers, at the border between the red and white skin."),
  (3, "Zhōngzhǔ", "中渚", "Central Islet", "hand", "On the dorsum of the hand, between the fourth and fifth metacarpal bones, in the depression proximal to the fourth metacarpophalangeal joint."),
  (4, "Yángchí", "阳池", "Yang Pool", "wrist", "On the posterior aspect of the wrist, in the depression ulnar to the extensor digitorum tendon, on the dorsal wrist crease."),
  (5, "Wàiguān", "外关", "Outer Pass", "forearm", "On the posterior aspect of the forearm, at the midpoint of the interosseous space between the radius and the ulna, 2 B-cun proximal to the dorsal wrist crease."),
  (6, "Zhīgōu", "支沟", "Branch Ditch", "forearm", "On the posterior aspect of the forearm, at the midpoint of the interosseous space between the radius and the ulna, 3 B-cun proximal to the dorsal wrist crease."),
  (7, "Huìzōng", "会宗", "Convergence and Gathering", "forearm", "On the posterior aspect of the forearm, just radial to the ulna, 3 B-cun proximal to the dorsal wrist crease."),
  (8, "Sānyángluò", "三阳络", "Three Yang Connection", "forearm", "On the posterior aspect of the forearm, at the midpoint of the interosseous space between the radius and the ulna, 4 B-cun proximal to the dorsal wrist crease."),
  (9, "Sìdú", "四渎", "Four Rivers", "forearm", "On the posterior aspect of the forearm, at the midpoint of the interosseous space between the radius and the ulna, 5 B-cun distal to the prominence of the olecranon."),
  (10, "Tiānjǐng", "天井", "Celestial Well", "elbow", "On the posterior aspect of the elbow, in the depression 1 B-cun proximal to the prominence of the olecranon."),
  (11, "Qīnglěngyuān", "清冷渊", "Clear Cold Abyss", "upper-arm", "On the posterior aspect of the arm, on the line connecting the prominence of the olecranon with the acromial angle, 2 B-cun proximal to the prominence of the olecranon."),
  (12, "Xiāoluò", "消泺", "Dispersing Riverbed", "upper-arm", "On the posterior aspect of the arm, on the line connecting the prominence of the olecranon with the acromial angle, 5 B-cun proximal to the prominence of the olecranon."),
  (13, "Nàohuì", "臑会", "Upper Arm Convergence", "upper-arm", "On the posterior aspect of the arm, posteroinferior to the border of the deltoid muscle, 3 B-cun inferior to the acromial angle."),
  (14, "Jiānliáo", "肩髎", "Shoulder Bone-Hole", "shoulder", "In the shoulder girdle region, in the depression between the acromial angle and the greater tubercle of the humerus."),
  (15, "Tiānliáo", "天髎", "Celestial Bone-Hole", "upper-back", "In the scapular region, in the depression superior to the superior angle of the scapula."),
  (16, "Tiānyǒu", "天牖", "Celestial Window", "neck", "In the anterior region of the neck, at the level of the angle of the mandible, in the depression posterior to the sternocleidomastoid muscle."),
  (17, "Yìfēng", "翳风", "Wind Screen", "neck", "In the anterior region of the neck, posterior to the ear lobe, in the depression anterior to the inferior end of the mastoid process."),
  (18, "Chìmài", "瘈脉", "Spasm Vessel", "head", "On the head, at the centre of the mastoid process, at the junction of the upper two thirds and lower third of the curved line connecting TE17 with TE20."),
  (19, "Lúxī", "颅息", "Skull Rest", "head", "On the head, at the junction of the upper third and lower two thirds of the curved line connecting TE17 with TE20."),
  (20, "Jiǎosūn", "角孙", "Angle Vertex", "head", "On the head, just superior to the auricular apex."),
  (21, "Ěrmén", "耳门", "Ear Gate", "face", "On the face, in the depression between the supratragic notch and the condylar process of the mandible (with the mouth open)."),
  (22, "Ěrhéliáo", "耳和髎", "Harmony Bone-Hole", "head", "On the side of the head, posterior to the hairline of the temple, anterior to the root of the auricle, posterior to the superficial temporal artery."),
  (23, "Sīzhúkōng", "丝竹空", "Silk Bamboo Hollow", "head", "On the head, in the depression at the lateral end of the eyebrow."),
]

ARM = {"LU": LU, "LI": LI, "HT": HT, "SI": SI, "PC": PC, "TE": TE}
