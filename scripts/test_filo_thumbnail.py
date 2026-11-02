#!/usr/bin/env python3
import unittest

from score_filo_thumbnail import score_features


class ThumbnailScoringTests(unittest.TestCase):
    def setUp(self):
        self.visual = {
            "sharpness": 180,
            "brightness": 125,
            "contrast": 58,
        }

    def test_clear_expressive_face_outranks_plain_scene(self):
        scene_score, _ = score_features({**self.visual, "face_count": 0})
        face_score, details = score_features({
            **self.visual,
            "face_count": 1,
            "face_area": 0.12,
            "center_score": 0.95,
            "frontal_score": 0.95,
            "expression_score": 0.9,
            "eyes_open_score": 0.95,
        })
        self.assertGreater(face_score, scene_score)
        self.assertTrue(details["faceDetected"])
        self.assertGreater(details["expressionScore"], 0.8)

    def test_expressive_face_outranks_neutral_face(self):
        base = {
            **self.visual,
            "face_count": 1,
            "face_area": 0.10,
            "center_score": 0.9,
            "frontal_score": 0.9,
            "eyes_open_score": 0.9,
        }
        neutral, _ = score_features({**base, "expression_score": 0.05})
        expressive, _ = score_features({**base, "expression_score": 0.9})
        self.assertGreater(expressive, neutral)

    def test_blurry_frame_loses_to_sharp_frame_with_same_face(self):
        base = {
            "face_count": 1,
            "face_area": 0.10,
            "center_score": 0.9,
            "frontal_score": 0.9,
            "expression_score": 0.5,
            "eyes_open_score": 0.8,
            "brightness": 125,
            "contrast": 58,
        }
        blurry, _ = score_features({**base, "sharpness": 5})
        sharp, _ = score_features({**base, "sharpness": 220})
        self.assertGreater(sharp, blurry)

    def test_out_of_center_face_loses_to_well_composed_face(self):
        base = {
            **self.visual,
            "face_count": 1,
            "face_area": 0.10,
            "frontal_score": 0.9,
            "expression_score": 0.5,
            "eyes_open_score": 0.8,
        }
        off_center, _ = score_features({**base, "center_score": 0.1})
        centered, _ = score_features({**base, "center_score": 0.95})
        self.assertGreater(centered, off_center)

    def test_no_face_fallback_uses_image_quality(self):
        dull, _ = score_features({"face_count": 0, "sharpness": 20, "brightness": 70, "contrast": 12})
        crisp, _ = score_features({"face_count": 0, "sharpness": 220, "brightness": 125, "contrast": 55})
        self.assertGreater(crisp, dull)


if __name__ == "__main__":
    unittest.main()
