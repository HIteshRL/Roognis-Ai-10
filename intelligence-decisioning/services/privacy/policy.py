def privacy_filter_aggregate(payload: dict, *, minimum_cohort_size: int) -> dict:
    cohort_size = int(payload.get("cohortSize") or 0)
    if cohort_size < minimum_cohort_size:
        return {
            "suppressed": True,
            "reason": "minimum_cohort_not_met",
            "minimumCohortSize": minimum_cohort_size,
            "cohortSize": cohort_size,
            "concepts": [],
        }

    concepts = []
    for row in payload.get("concepts") or []:
        # Suppress sparse concept slices too: a large classroom must not make a
        # one-student concept inference visible by accident.
        student_count = int(row.get("studentCount") or 0)
        if student_count < minimum_cohort_size:
            continue
        concepts.append({
            "conceptId": str(row.get("conceptId") or ""),
            "coveredStudentCount": student_count,
            "averageMastery": round(float(row.get("averageMastery") or 0), 3),
            "averageGapScore": round(float(row.get("averageGapScore") or 0), 3),
            "averageConfidence": round(float(row.get("averageConfidence") or 0), 3),
        })
    return {
        "suppressed": False,
        "cohortSize": cohort_size,
        "minimumCohortSize": minimum_cohort_size,
        "concepts": concepts,
    }
