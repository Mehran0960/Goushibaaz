#!/usr/bin/env python3
"""Rank sampled video frames for a strong, honest thumbnail using local face landmarks."""
import json
import math
import os
import sys

import cv2
import mediapipe as mp


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def score_features(features):
    """Return a deterministic 0..100 frame score from visual and face cues."""
    sharpness = max(0.0, float(features.get("sharpness", 0.0)))
    brightness = clamp01(1.0 - abs(float(features.get("brightness", 128.0)) - 125.0) / 132.0)
    contrast = clamp01(float(features.get("contrast", 0.0)) / 62.0)
    sharpness_score = clamp01(math.log1p(sharpness) / math.log1p(500.0))

    visual_score = 18.0 * sharpness_score + 9.0 * brightness + 8.0 * contrast

    face_count = max(0, int(features.get("face_count", 0)))
    if face_count <= 0:
        return round(visual_score, 3), {
            "sharpnessScore": round(sharpness_score, 3),
            "faceDetected": False,
            "faceCount": 0,
            "expressionScore": 0.0,
            "sharpness": round(sharpness, 2),
            "brightness": round(float(features.get("brightness", 0.0)), 2),
            "contrast": round(float(features.get("contrast", 0.0)), 2),
        }

    face_area = clamp01(float(features.get("face_area", 0.0)) / 0.14)
    center = clamp01(features.get("center_score", 0.0))
    frontal = clamp01(features.get("frontal_score", 0.0))
    expression = clamp01(features.get("expression_score", 0.0))
    eyes_open = clamp01(features.get("eyes_open_score", 0.0))
    group_bonus = min(3.0, max(0, face_count - 1) * 1.2)

    face_score = (
        11.0
        + 11.0 * face_area
        + 7.0 * center
        + 6.0 * frontal
        + 14.0 * expression
        + 4.0 * eyes_open
        + group_bonus
    )
    total = visual_score + face_score
    return round(total, 3), {
        "sharpnessScore": round(sharpness_score, 3),
        "faceDetected": True,
        "faceCount": face_count,
        "expressionScore": round(expression, 3),
        "sharpness": round(sharpness, 2),
        "brightness": round(float(features.get("brightness", 0.0)), 2),
        "contrast": round(float(features.get("contrast", 0.0)), 2),
        "faceArea": round(float(features.get("face_area", 0.0)), 4),
        "centerScore": round(center, 3),
        "frontalScore": round(frontal, 3),
        "eyesOpenScore": round(eyes_open, 3),
    }


def _point(landmarks, index):
    point = landmarks[index]
    return float(point.x), float(point.y)


def _distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def face_features(landmarks):
    xs = [float(point.x) for point in landmarks]
    ys = [float(point.y) for point in landmarks]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    width = max(1e-5, right - left)
    height = max(1e-5, bottom - top)
    area = width * height

    center_x = (left + right) / 2.0
    center_y = (top + bottom) / 2.0
    center_distance = math.sqrt(((center_x - 0.5) / 0.5) ** 2 + ((center_y - 0.47) / 0.55) ** 2)
    center_score = clamp01(1.0 - center_distance / 1.25)

    nose = _point(landmarks, 1)
    left_eye_outer = _point(landmarks, 33)
    left_eye_inner = _point(landmarks, 133)
    right_eye_inner = _point(landmarks, 362)
    right_eye_outer = _point(landmarks, 263)
    eye_mid_x = (left_eye_outer[0] + left_eye_inner[0] + right_eye_inner[0] + right_eye_outer[0]) / 4.0
    eye_width = max(1e-5, _distance(left_eye_outer, right_eye_outer))
    yaw_offset = abs(nose[0] - eye_mid_x) / eye_width
    frontal_score = clamp01(1.0 - yaw_offset / 0.16)

    left_eye_height = _distance(_point(landmarks, 159), _point(landmarks, 145))
    left_eye_width = max(1e-5, _distance(left_eye_outer, left_eye_inner))
    right_eye_height = _distance(_point(landmarks, 386), _point(landmarks, 374))
    right_eye_width = max(1e-5, _distance(right_eye_outer, right_eye_inner))
    eye_ratio = (left_eye_height / left_eye_width + right_eye_height / right_eye_width) / 2.0
    eyes_open_score = clamp01((eye_ratio - 0.07) / 0.20)

    mouth_left = _point(landmarks, 61)
    mouth_right = _point(landmarks, 291)
    upper_lip = _point(landmarks, 13)
    lower_lip = _point(landmarks, 14)
    mouth_width = max(1e-5, _distance(mouth_left, mouth_right))
    mouth_open_ratio = _distance(upper_lip, lower_lip) / mouth_width
    corner_lift = (upper_lip[1] - (mouth_left[1] + mouth_right[1]) / 2.0) / mouth_width
    smile_signal = clamp01((corner_lift + 0.005) / 0.065)
    open_mouth_signal = clamp01((mouth_open_ratio - 0.09) / 0.27)
    expression_score = clamp01(0.72 * smile_signal + 0.52 * open_mouth_signal)

    return {
        "face_area": area,
        "center_score": center_score,
        "frontal_score": frontal_score,
        "eyes_open_score": eyes_open_score,
        "expression_score": expression_score,
    }


def analyze_image(image, face_mesh):
    height, width = image.shape[:2]
    scale = min(1.0, 720.0 / max(width, height))
    if scale < 1.0:
        image = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
    brightness = float(gray.mean())
    contrast = float(gray.std())

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    result = face_mesh.process(rgb)
    faces = []
    if result.multi_face_landmarks:
        for face in result.multi_face_landmarks:
            features = face_features(face.landmark)
            if features["face_area"] >= 0.004:
                faces.append(features)

    if faces:
        # Prefer a large, visible and expressive face, while retaining multi-person cues.
        strongest = max(
            faces,
            key=lambda item: (
                item["face_area"] * 1.3
                + item["expression_score"] * 0.55
                + item["center_score"] * 0.25
                + item["frontal_score"] * 0.15
            ),
        )
        combined = dict(strongest)
        combined["face_count"] = len(faces)
    else:
        combined = {"face_count": 0}

    combined.update({
        "sharpness": sharpness,
        "brightness": brightness,
        "contrast": contrast,
    })
    score, details = score_features(combined)
    return score, details


def main():
    payload = json.load(sys.stdin)
    frames = payload.get("frames", [])
    if not frames:
        raise ValueError("no_frames_supplied")

    scored = []
    with mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=6,
        refine_landmarks=False,
        min_detection_confidence=0.45,
    ) as face_mesh:
        for frame in frames:
            image_path = frame.get("path")
            if not image_path or not os.path.isfile(image_path):
                continue
            image = cv2.imread(image_path)
            if image is None or image.size == 0:
                continue
            score, details = analyze_image(image, face_mesh)
            scored.append({
                "index": int(frame.get("index", len(scored))),
                "timeSeconds": float(frame.get("timeSeconds", 0.0)),
                "score": score,
                **details,
            })

    if not scored:
        raise ValueError("no_frames_decoded")

    scored.sort(key=lambda item: (-item["score"], item["timeSeconds"]))
    selected = scored[0]
    print(json.dumps({
        "selectedIndex": selected["index"],
        "selected": selected,
        "selectionReason": "face_expression_and_visual_quality" if selected["faceDetected"] else "best_visual_quality_no_face_detected",
        "ranked": scored[:5],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
