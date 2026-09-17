from policy import privacy_filter_aggregate


def test_suppresses_small_classrooms():
    result = privacy_filter_aggregate({"cohortSize": 4, "concepts": []}, minimum_cohort_size=5)
    assert result["suppressed"] is True


def test_suppresses_sparse_concepts_inside_large_classroom():
    result = privacy_filter_aggregate({
        "cohortSize": 12,
        "concepts": [
            {"conceptId": "fractions", "studentCount": 8, "averageMastery": 0.4, "averageGapScore": 0.6, "averageConfidence": 0.7},
            {"conceptId": "rare", "studentCount": 1, "averageMastery": 0.1, "averageGapScore": 0.9, "averageConfidence": 0.9},
        ],
    }, minimum_cohort_size=5)
    assert [row["conceptId"] for row in result["concepts"]] == ["fractions"]
    assert "studentId" not in result["concepts"][0]
    assert "evidenceIds" not in result["concepts"][0]
    assert "rawAnswers" not in result["concepts"][0]
