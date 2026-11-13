---
id: point-location
title: Locating a point on this patient
when: Before you palpate or mark the first point of a visit, and whenever a point's construction crosses onto another chart.
---
A point is located on the patient in front of you, in the position you will needle in. The textbook gives the construction; the patient gives the numbers.

1. **Position first.** Put the patient in the treatment position before you palpate. A chart has configurations (a knee extended or flexed, lying or seated): a landmark palpated in one does not hold in another, and marks made before a change of position go stale.
2. **Read the construction.** `lookup point` gives the location in words and as a construction: a landmark; a fraction between two landmarks; or a distance from one landmark towards another, with offsets. Distances are in B-cun of a named segment of the chart (`lookup region`: landmarks with how each is found, segments with their cun), in finger cun, or occasionally in centimetres.
3. **Ask what is needed.** `construct_point` with the point and side tells you which landmarks to palpate and which segments to measure, chart by chart. Do those: `identify_landmark` for each landmark, `measure` for each segment (`fingerCun: true` for the patient's finger cun). Each needs that body site within arm's reach, so do one side of the couch, then the other.
4. **Construct.** `construct_point` again returns the position on the chart and an input ready for `mark_point`. One B-cun is the measured length of the segment divided by its cun: it is this patient's, and it differs from segment to segment.
5. **Across a seam.** A point measured from a point on a neighbouring chart (the construction names `point:<id>`) needs the landmarks the two charts share at their seam palpated on both; `construct_point` lists them and carries the position across.
6. **Mark.** `mark_point` with the target, the chart position and the method. A group point (Sishencong, Jiaji, Shixuan …) is located, marked and needled site by site: name the site.
7. **Ashi points.** A tender point found on examination is in your record with its position: mark it by palpation (`method: "palpation"`), at the tenderest spot.

Marking touches the skin, so clean the site after the marks are made. If the patient is moved afterwards, check the marks in `view` localisation: a stale mark is re-made, not needled.
