from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Dict
import os, re, csv, io, base64
import pydicom
import numpy as np
from PIL import Image

app = FastAPI()

# Enable CORS (adjust allow_origins as needed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Change for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----- API Models -----
class ScanDirectoryRequest(BaseModel):
    directory_path: str

class UpdateRequest(BaseModel):
    patientName: str
    dicomName: str
    label: int

class PatientDicomsRequest(BaseModel):
    patientName: str

# ----- Helper Functions -----
CSV_FILE_PATH = "patient_dicom_labels.csv"

def convert_frame_to_base64(frame: np.ndarray) -> str:
    if frame.max() > 0:
        normalized_frame = ((frame / frame.max()) * 255).astype(np.uint8)
    else:
        normalized_frame = frame.astype(np.uint8)
    image = Image.fromarray(normalized_frame).convert("L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('utf-8')}"

def extract_patient_number(name: str) -> int:
    match = re.search(r'\d+', name)
    return int(match.group()) if match else float('inf')

def save_to_csv(patients_data: List[Dict]):
    headers = ["patientName", "dicomName", "label", "filepath", "frameCount"]
    patients_data_sorted = sorted(patients_data, key=lambda x: extract_patient_number(x["patientName"]))
    with open(CSV_FILE_PATH, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(headers)
        for patient in patients_data_sorted:
            for dicom in patient["dicoms"]:
                writer.writerow([
                    patient["patientName"],
                    dicom["dicomName"],
                    dicom.get("label", 0),
                    dicom.get("filepath", ""),
                    dicom.get("frameCount", 0)
                ])
    print(f"Data saved to {CSV_FILE_PATH}")

def load_from_csv():
    if not os.path.exists(CSV_FILE_PATH):
        print(f"CSV file {CSV_FILE_PATH} not found")
        return []
    patients = {}
    with open(CSV_FILE_PATH, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader)
        for row in reader:
            if len(row) < 3:
                print(f"Skipping malformed row: {row}")
                continue
            patient_name, dicom_name, label_str = row[0], row[1], row[2]
            filepath = row[3] if len(row) > 3 else ""
            try:
                frame_count = int(row[4]) if len(row) > 4 and row[4].isdigit() else 0
            except:
                frame_count = 0
            if patient_name not in patients:
                patients[patient_name] = {"patientName": patient_name, "dicoms": []}
            patients[patient_name]["dicoms"].append({
                "dicomName": dicom_name,
                "label": int(label_str),
                "filepath": filepath,
                "frameCount": frame_count
            })
    patient_list = list(patients.values())
    print(f"Loaded {len(patient_list)} patients from CSV")
    return patient_list

def update_csv_with_label(patient_name: str, dicom_name: str, label: int):
    if not os.path.exists(CSV_FILE_PATH):
        patients_data = [{
            "patientName": patient_name,
            "dicoms": [{
                "dicomName": dicom_name,
                "label": label,
                "filepath": "",
                "frameCount": 0
            }]
        }]
        save_to_csv(patients_data)
        return True
    rows = []
    found = False
    with open(CSV_FILE_PATH, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader)
        rows.append(headers)
        for row in reader:
            if len(row) < 3:
                rows.append(row)
                continue
            if row[0] == patient_name and row[1] == dicom_name:
                row[2] = str(label)
                found = True
            rows.append(row)
    if not found:
        rows.append([patient_name, dicom_name, str(label), "", "0"])
    with open(CSV_FILE_PATH, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        for row in rows:
            writer.writerow(row)
    print(f"Updated CSV for {patient_name}/{dicom_name} with label {label}")
    return True

# ----- API Endpoints -----
@app.post("/scan-directory")
async def scan_directory(request: ScanDirectoryRequest):
    directory_path = request.directory_path
    print(f"Scanning directory: {directory_path}")
    if not os.path.exists(directory_path):
        raise HTTPException(status_code=404, detail=f"Directory not found: {directory_path}")
    if not os.path.isdir(directory_path):
        raise HTTPException(status_code=400, detail=f"Not a directory: {directory_path}")
    
    csv_patients = load_from_csv() if os.path.exists(CSV_FILE_PATH) else []
    csv_patient_dict = {}
    for patient in csv_patients:
        csv_patient_dict[patient["patientName"]] = {"patientName": patient["patientName"], "dicoms": {}}
        for dicom in patient["dicoms"]:
            csv_patient_dict[patient["patientName"]]["dicoms"][dicom["dicomName"]] = dicom

    patients = {}
    for root, dirs, files in os.walk(directory_path):
        for file in files:
            rel_path = os.path.relpath(root, directory_path)
            if rel_path == ".":
                continue
            parts = rel_path.split(os.sep)
            if not parts:
                continue
            patientName = parts[0]
            filepath = os.path.join(root, file)
            dicomName = file
            print(f"Found potential DICOM: {patientName}/{dicomName}")
            if patientName not in patients:
                patients[patientName] = {"patientName": patientName, "dicoms": {}}
            label = 0
            if patientName in csv_patient_dict and dicomName in csv_patient_dict[patientName]["dicoms"]:
                label = csv_patient_dict[patientName]["dicoms"][dicomName].get("label", 0)
                print(f"Found existing label for {patientName}/{dicomName}: {label}")
            frame_count = 0
            try:
                ds = pydicom.dcmread(filepath, stop_before_pixels=True)
                if not hasattr(ds, 'SOPClassUID'):
                    print(f"Not a valid DICOM file: {filepath}")
                    continue
                frame_count = int(ds.NumberOfFrames) if hasattr(ds, 'NumberOfFrames') else 1
                print(f"Estimated {frame_count} frames for DICOM: {filepath}")
            except Exception as e:
                print(f"Error reading {filepath}: {e}")
                continue
            patients[patientName]["dicoms"][dicomName] = {
                "dicomName": dicomName,
                "label": label,
                "filepath": filepath,
                "frameCount": frame_count
            }
    patient_list = []
    for patient_name, data in patients.items():
        patient_list.append({
            "patientName": patient_name,
            "dicoms": list(data["dicoms"].values())
        })
    save_to_csv(patient_list)
    print(f"Returning {len(patient_list)} patients with metadata")
    return {"patients": patient_list}

@app.post("/fetch-patient-dicoms")
async def fetch_patient_dicoms(request: PatientDicomsRequest):
    patient_name = request.patientName
    csv_patients = load_from_csv()
    patient_dicoms = []
    for patient in csv_patients:
        if patient["patientName"] == patient_name:
            for dicom in patient["dicoms"]:
                dicomName = dicom["dicomName"]
                filepath = dicom.get("filepath")
                label = dicom.get("label", 0)
                if filepath and os.path.exists(filepath):
                    try:
                        ds = pydicom.dcmread(filepath)
                        pixel_array = ds.pixel_array
                        frames = [pixel_array[i] for i in range(pixel_array.shape[0])] if len(pixel_array.shape) > 2 else [pixel_array]
                        images = [{"id": f"{dicomName}-{i+1}", "src": convert_frame_to_base64(frame)} for i, frame in enumerate(frames)]
                        patient_dicoms.append({"dicomName": dicomName, "label": label, "images": images})
                    except Exception as e:
                        patient_dicoms.append({"dicomName": dicomName, "label": label, "images": [], "error": str(e)})
            break
    if not patient_dicoms:
        raise HTTPException(status_code=404, detail=f"No DICOMs found for patient: {patient_name}")
    return {"patientName": patient_name, "dicoms": patient_dicoms}

@app.get("/fetch-csv")
async def fetch_csv():
    if not os.path.exists(CSV_FILE_PATH):
        return {"patients": []}
    return {"patients": load_from_csv()}

@app.post("/update-csv")
async def update_csv(update_request: UpdateRequest):
    try:
        success = update_csv_with_label(update_request.patientName, update_request.dicomName, update_request.label)
        return {"success": success}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----- Mount static files AFTER all API endpoints have been added -----
# This ensures your POST endpoints are not shadowed by the StaticFiles mount.
app.mount("/", StaticFiles(directory="../frontend/build", html=True), name="static")
