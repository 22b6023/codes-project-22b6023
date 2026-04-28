from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import joblib
import pandas as pd
import numpy as np
import re
import os
from io import BytesIO

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)

# CONFIG

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "saved_best_models")

@app.route("/")
def home():
    return render_template("index.html")


SEMESTER_NUM_TO_SHEET = {
    2: "Y1S1",
    3: "Y1S2",
    4: "Y2S1",
    5: "Y2S2",
    6: "Y3S1",
    7: "Y3S2",
    8: "Y4S1"
}

SEMESTER_NUM_TO_LABEL = {
    1: "Y1S1",
    2: "Y1S2",
    3: "Y2S1",
    4: "Y2S2",
    5: "Y3S1",
    6: "Y3S2",
    7: "Y4S1",
    8: "Y4S2"
}

# HELPERS

def safe_float(value):
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except Exception:
        return 0.0

def parse_level_type(module_code: str):
    if module_code is None:
        return (np.nan, np.nan)
    s = str(module_code).strip()
    m = re.search(r"-(\d)(\d)", s)
    if not m:
        return (np.nan, np.nan)
    return (int(m.group(1)), int(m.group(2)))

def wavg_zero(marks, weights):
    marks = pd.to_numeric(pd.Series(marks), errors="coerce")
    weights = pd.to_numeric(pd.Series(weights), errors="coerce").fillna(0)

    mask = marks.notna() & (weights > 0)
    if mask.sum() == 0:
        return 0.0

    return float((marks[mask] * weights[mask]).sum() / weights[mask].sum())

def build_semester_features(sheet_label, semester_data):
    gpa = safe_float(semester_data.get("gpa", 0))
    modules = semester_data.get("modules", [])

    rows = []
    for m in modules:
        module_code = str(m.get("module_code", "")).strip()
        mc = safe_float(m.get("mc", 0))
        marks = safe_float(m.get("marks", 0))

        if not module_code or mc <= 0:
            continue

        level, module_type = parse_level_type(module_code)

        rows.append({
            "MODULE_CODE": module_code,
            "MC": mc,
            "MARKS": marks,
            "module_level": level,
            "module_type": module_type
        })

    df = pd.DataFrame(rows)

    features = {
        f"GPA_{sheet_label}": gpa
    }

    # If no valid modules, fill all semester features with 0
    if df.empty:
        features.update({
            f"wavg_mark_{sheet_label}": 0.0,
            f"avg_mark_{sheet_label}": 0.0,
            f"mark_min_{sheet_label}": 0.0,
            f"mark_max_{sheet_label}": 0.0,
            f"mark_std_{sheet_label}": 0.0,
        })

        for L in [1, 2, 3, 4]:
            features[f"wavg_mark_L{L}_{sheet_label}"] = 0.0

        for T in [1, 2, 3, 4, 5]:
            features[f"wavg_mark_T{T}_{sheet_label}"] = 0.0

        return features

    # Core stats
    marks_series = pd.to_numeric(df["MARKS"], errors="coerce")
    features[f"wavg_mark_{sheet_label}"] = wavg_zero(df["MARKS"], df["MC"])
    features[f"avg_mark_{sheet_label}"] = float(marks_series.mean()) if marks_series.notna().any() else 0.0
    features[f"mark_min_{sheet_label}"] = float(marks_series.min()) if marks_series.notna().any() else 0.0
    features[f"mark_max_{sheet_label}"] = float(marks_series.max()) if marks_series.notna().any() else 0.0
    features[f"mark_std_{sheet_label}"] = float(marks_series.std(ddof=0)) if marks_series.notna().any() else 0.0

    # Level based weighted averages
    for L in [1, 2, 3, 4]:
        g = df.loc[df["module_level"] == L]
        features[f"wavg_mark_L{L}_{sheet_label}"] = wavg_zero(g["MARKS"], g["MC"])

    # Type based weighted averages
    for T in [1, 2, 3, 4, 5]:
        g = df.loc[df["module_type"] == T]
        features[f"wavg_mark_T{T}_{sheet_label}"] = wavg_zero(g["MARKS"], g["MC"])

    return features

def build_feature_map_from_payload(payload, predict_semester_x):
    """
    Student chooses to predict at semester X.
    They provide history from semester 1 to X-1.
    We compute only those historical semester features.
    Any feature not present later will be filled as 0.
    """
    semesters = payload.get("semesters", {})
    feature_map = {}

    # Build features only for entered history semesters: 1 to X-1
    for sem_num in range(1, predict_semester_x):
        sheet_label = SEMESTER_NUM_TO_LABEL[sem_num]
        semester_data = semesters.get(str(sem_num), {"gpa": 0, "modules": []})
        feature_map.update(build_semester_features(sheet_label, semester_data))

    return feature_map

def load_model_and_features_for_x(predict_semester_x):
    if predict_semester_x not in SEMESTER_NUM_TO_SHEET:
        raise ValueError(f"Semester {predict_semester_x} is not supported.")

    checkpoint_sheet = SEMESTER_NUM_TO_SHEET[predict_semester_x]

    model_path = os.path.join(MODEL_DIR, f"best_model_{checkpoint_sheet}.pkl")
    features_path = os.path.join(MODEL_DIR, f"best_features_{checkpoint_sheet}.pkl")

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found: {model_path}")
    if not os.path.exists(features_path):
        raise FileNotFoundError(f"Feature file not found: {features_path}")

    model = joblib.load(model_path)
    feature_columns = joblib.load(features_path)

    return checkpoint_sheet, model, feature_columns

def make_ordered_input_row(feature_map, feature_columns):
    row = {}
    for col in feature_columns:
        row[col] = safe_float(feature_map.get(col, 0))
    return row

def get_recommendation(risk, decline_detected):
    if risk == "High Risk":
        base = "Immediate academic advising and targeted intervention are recommended."
    elif risk == "Moderate Risk":
        base = "Closer monitoring and early support are recommended."
    else:
        base = "Maintain progress and continue regular academic monitoring."

    if decline_detected:
        base += " Recent semester decline detected."
    return base

def detect_decline(feature_map, predict_semester_x):
    # Compare last two  GPA points before X
    gpas = []
    for sem_num in range(1, predict_semester_x):
        sheet_label = SEMESTER_NUM_TO_LABEL[sem_num]
        gpas.append(safe_float(feature_map.get(f"GPA_{sheet_label}", 0)))

    if len(gpas) < 2:
        return False

    return gpas[-1] < gpas[-2]

# ROUTES

@app.route("/predict", methods=["POST"])
def predict():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON payload received."}), 400

        predict_semester_x = int(data.get("predict_semester_x", 0))
        if predict_semester_x not in [2, 3, 4, 5, 6, 7, 8]:
            return jsonify({"error": "predict_semester_x must be one of 2,3,4,5,6,7,8"}), 400

        checkpoint_sheet, model, feature_columns = load_model_and_features_for_x(predict_semester_x)

        feature_map = build_feature_map_from_payload(data, predict_semester_x)
        ordered_row = make_ordered_input_row(feature_map, feature_columns)

        X_input = pd.DataFrame([ordered_row], columns=feature_columns)
        prediction = model.predict(X_input)[0]

        decline_detected = detect_decline(feature_map, predict_semester_x)
        recommendation = get_recommendation(str(prediction), decline_detected)

        return jsonify({
            "prediction": str(prediction),
            "predict_semester_x": predict_semester_x,
            "model_checkpoint_used": checkpoint_sheet,
            "decline_detected": decline_detected,
            "recommendation": recommendation,
            "features_used": ordered_row
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/predict_batch", methods=["POST"])
def predict_batch():
    try:
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded."}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"error": "Empty filename."}), 400

        workbook = pd.read_excel(BytesIO(file.read()), sheet_name=None)

        required_sheets = ["Y1S1", "Y1S2", "Y2S1", "Y2S2"]
        missing_sheets = [s for s in required_sheets if s not in workbook]
        if missing_sheets:
            return jsonify({"error": f"Missing required sheets: {missing_sheets}"}), 400

        all_rows = []

        for semester in required_sheets:
            df = workbook[semester].copy()
            df.columns = df.columns.astype(str).str.strip()

            required_cols = ["REGNO", "MAJOR", "MODULE_CODE", "MC", "MARKS", "GPA"]
            missing_cols = [c for c in required_cols if c not in df.columns]
            if missing_cols:
                return jsonify({
                    "error": f"Sheet {semester} is missing required columns: {missing_cols}"
                }), 400

            df["REGNO"] = df["REGNO"].astype(str).str.strip()
            df["MAJOR"] = df["MAJOR"].astype(str).str.strip()
            df["MODULE_CODE"] = df["MODULE_CODE"].astype(str).str.strip()
            df["MC"] = pd.to_numeric(df["MC"], errors="coerce").fillna(0)
            df["MARKS"] = pd.to_numeric(df["MARKS"], errors="coerce").fillna(0)
            df["GPA"] = pd.to_numeric(df["GPA"], errors="coerce").fillna(0)
            df["SEMESTER"] = semester

            all_rows.append(df)

        full_df = pd.concat(all_rows, ignore_index=True)

        # Lecturer batch view
        checkpoint_sheet, model, feature_columns = load_model_and_features_for_x(5)

        results = []
        feature_rows = []

        sheet_to_semnum = {
            "Y1S1": 1,
            "Y1S2": 2,
            "Y2S1": 3,
            "Y2S2": 4
        }

        for regno, g_student in full_df.groupby("REGNO"):
            major = g_student["MAJOR"].iloc[0] if "MAJOR" in g_student.columns else ""

            payload = {
                "student_id": regno,
                "major": major,
                "predict_semester_x": 5,
                "semesters": {}
            }

            for sheet_name, sem_num in sheet_to_semnum.items():
                g_sem = g_student[g_student["SEMESTER"] == sheet_name].copy()

                if g_sem.empty:
                    payload["semesters"][str(sem_num)] = {
                        "gpa": 0,
                        "modules": []
                    }
                    continue

                gpa = safe_float(g_sem["GPA"].iloc[0])

                modules = []
                for _, row in g_sem.iterrows():
                    modules.append({
                        "module_code": row["MODULE_CODE"],
                        "mc": row["MC"],
                        "marks": row["MARKS"]
                    })

                payload["semesters"][str(sem_num)] = {
                    "gpa": gpa,
                    "modules": modules
                }

            feature_map = build_feature_map_from_payload(payload, 5)
            ordered_row = make_ordered_input_row(feature_map, feature_columns)

            feature_rows.append({
                "REGNO": regno,
                "MAJOR": major,
                **ordered_row
            })

        feature_df = pd.DataFrame(feature_rows)

        X_batch = feature_df[feature_columns].copy()
        preds = model.predict(X_batch)
        feature_df["prediction"] = preds

        for _, row in feature_df.iterrows():
            results.append({
                "REGNO": row["REGNO"],
                "MAJOR": row["MAJOR"],
                "GPA_Y1S1": round(safe_float(row.get("GPA_Y1S1", 0)), 4),
                "GPA_Y1S2": round(safe_float(row.get("GPA_Y1S2", 0)), 4),
                "GPA_Y2S1": round(safe_float(row.get("GPA_Y2S1", 0)), 4),
                "GPA_Y2S2": round(safe_float(row.get("GPA_Y2S2", 0)), 4),
                "Latest_WAVG_Mark": round(safe_float(row.get("wavg_mark_Y2S2", 0)), 4),
                "prediction": str(row["prediction"])
            })

        results_df = pd.DataFrame(results)

        summary = results_df["prediction"].value_counts().to_dict()
        total_students = len(results_df)

        percentages = {
            "High Risk": round((summary.get("High Risk", 0) / total_students) * 100, 2) if total_students else 0,
            "Moderate Risk": round((summary.get("Moderate Risk", 0) / total_students) * 100, 2) if total_students else 0,
            "Low Risk": round((summary.get("Low Risk", 0) / total_students) * 100, 2) if total_students else 0
        }

        # Major with most high-risk students
        high_df = results_df[results_df["prediction"] == "High Risk"]
        if not high_df.empty:
            major_counts = high_df["MAJOR"].value_counts()
            major_most_high_risk = f"{major_counts.index[0]} ({int(major_counts.iloc[0])})"
        else:
            major_most_high_risk = "None"

        # GPA trend by major (top 5 majors)
        top_majors = results_df["MAJOR"].value_counts().head(5).index.tolist()
        gpa_trend_by_major = {}
        for major in top_majors:
            g = results_df[results_df["MAJOR"] == major]
            gpa_trend_by_major[major] = {
                "Y1S1": round(float(g["GPA_Y1S1"].mean()), 4) if not g.empty else 0,
                "Y1S2": round(float(g["GPA_Y1S2"].mean()), 4) if not g.empty else 0,
                "Y2S1": round(float(g["GPA_Y2S1"].mean()), 4) if not g.empty else 0,
                "Y2S2": round(float(g["GPA_Y2S2"].mean()), 4) if not g.empty else 0
            }

        # Weighted mark trend by semester
        wavg_trend_by_semester = {
            "Y1S1": round(float(feature_df["wavg_mark_Y1S1"].mean()), 4) if "wavg_mark_Y1S1" in feature_df.columns else 0,
            "Y1S2": round(float(feature_df["wavg_mark_Y1S2"].mean()), 4) if "wavg_mark_Y1S2" in feature_df.columns else 0,
            "Y2S1": round(float(feature_df["wavg_mark_Y2S1"].mean()), 4) if "wavg_mark_Y2S1" in feature_df.columns else 0,
            "Y2S2": round(float(feature_df["wavg_mark_Y2S2"].mean()), 4) if "wavg_mark_Y2S2" in feature_df.columns else 0
        }

        # Sharpest GPA decline 
        avg_gpa_by_sem = {
            "Y1S1": round(float(results_df["GPA_Y1S1"].mean()), 4) if not results_df.empty else 0,
            "Y1S2": round(float(results_df["GPA_Y1S2"].mean()), 4) if not results_df.empty else 0,
            "Y2S1": round(float(results_df["GPA_Y2S1"].mean()), 4) if not results_df.empty else 0,
            "Y2S2": round(float(results_df["GPA_Y2S2"].mean()), 4) if not results_df.empty else 0
        }

        decline_pairs = [
            ("Y1S1 → Y1S2", avg_gpa_by_sem["Y1S2"] - avg_gpa_by_sem["Y1S1"]),
            ("Y1S2 → Y2S1", avg_gpa_by_sem["Y2S1"] - avg_gpa_by_sem["Y1S2"]),
            ("Y2S1 → Y2S2", avg_gpa_by_sem["Y2S2"] - avg_gpa_by_sem["Y2S1"])
        ]
        sharpest_decline_pair = min(decline_pairs, key=lambda x: x[1]) if decline_pairs else ("N/A", 0)
        semester_sharpest_decline = f"{sharpest_decline_pair[0]} ({round(sharpest_decline_pair[1], 4)})"

        # Weakest module level/type based on Y2S2 averages
        level_means = {}
        for L in [1, 2, 3, 4]:
            col = f"wavg_mark_L{L}_Y2S2"
            non_zero = feature_df[col][feature_df[col] > 0] if col in feature_df.columns else pd.Series(dtype=float)
            level_means[f"L{L}"] = float(non_zero.mean()) if not non_zero.empty else 0.0

        type_means = {}
        for T in [1, 2, 3, 4, 5]:
            col = f"wavg_mark_T{T}_Y2S2"
            non_zero = feature_df[col][feature_df[col] > 0] if col in feature_df.columns else pd.Series(dtype=float)
            type_means[f"T{T}"] = float(non_zero.mean()) if not non_zero.empty else 0.0

        weakest_level = min(level_means.items(), key=lambda x: x[1])
        weakest_type = min(type_means.items(), key=lambda x: x[1])

        weakest_module_level = f"{weakest_level[0]} ({round(weakest_level[1], 2)})"
        weakest_module_type = f"{weakest_type[0]} ({round(weakest_type[1], 2)})"

      
        risk_count_by_semester = {
            "Y1S1": {"High Risk": 0, "Moderate Risk": 0, "Low Risk": 0},
            "Y1S2": {"High Risk": 0, "Moderate Risk": 0, "Low Risk": 0},
            "Y2S1": {"High Risk": 0, "Moderate Risk": 0, "Low Risk": 0},
            "Y2S2": {
                "High Risk": int(summary.get("High Risk", 0)),
                "Moderate Risk": int(summary.get("Moderate Risk", 0)),
                "Low Risk": int(summary.get("Low Risk", 0))
            }
        }

        return jsonify({
            "total_students": total_students,
            "summary": {
                "High Risk": int(summary.get("High Risk", 0)),
                "Moderate Risk": int(summary.get("Moderate Risk", 0)),
                "Low Risk": int(summary.get("Low Risk", 0))
            },
            "percentages": percentages,
            "risk_count_by_semester": risk_count_by_semester,
            "gpa_trend_by_major": gpa_trend_by_major,
            "wavg_trend_by_semester": wavg_trend_by_semester,
            "derived": {
                "major_most_high_risk": major_most_high_risk,
                "semester_sharpest_decline": semester_sharpest_decline,
                "weakest_module_level": weakest_module_level,
                "weakest_module_type": weakest_module_type
            },
            "results": results
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500
        
# RUN

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
