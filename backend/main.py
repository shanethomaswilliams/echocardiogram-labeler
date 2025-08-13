from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Dict
import os, re, csv, io, base64, copy
import json
import random
import pydicom
import numpy as np
from PIL import Image
from pydicom.encaps import generate_pixel_data_frame
import tempfile
import cv2
import base64
from apng import APNG

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
class AccountRequest(BaseModel):
    username: str

class LoginRequest(BaseModel):
    username: str

# Update existing model classes
class ScanDirectoryRequest(BaseModel):
    butterfly_directory_path: str = ""
    vave_directory_path: str = ""
    butterfly_2_directory_path: str = ""
    username: str

from typing import Optional

class UpdateRequest(BaseModel):
    patientName: str
    dicomName: str
    label: int
    username: str
    kind: Optional[str] = "dicom"   # "dicom" or "apng"

class PatientDicomsRequest(BaseModel):
    patientName: str
    username: str

# ----- Helper Functions -----
MAIN_CSV_FILE_PATH = "patient_dicom_labels.csv"
ACCOUNTS_CSV_PATH = "user_accounts.csv"
PATIENT_MAPPING_FILE = "patient_mapping.json"

def get_user_csv_path(username: str):
    """Get the CSV file path for a specific user"""
    return f"user_{username}_labels.csv"

def load_accounts():
    """Load all user accounts from CSV"""
    if not os.path.exists(ACCOUNTS_CSV_PATH):
        return []
    
    accounts = []
    with open(ACCOUNTS_CSV_PATH, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader, None)
        if not headers or headers[0] != "username":
            return []
            
        for row in reader:
            if row and len(row) > 0:
                accounts.append({"username": row[0]})
    
    return accounts

def save_account(username: str):
    """Save a new user account to CSV"""
    accounts = load_accounts()
    
    # Check if account already exists
    for account in accounts:
        if account["username"] == username:
            return False  # Account already exists
    
    # Create accounts CSV if it doesn't exist
    if not os.path.exists(ACCOUNTS_CSV_PATH):
        with open(ACCOUNTS_CSV_PATH, 'w', newline='') as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(["username"])
    
    # Append the new account
    with open(ACCOUNTS_CSV_PATH, 'a', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow([username])
    
    return True

def convert_frame_to_base64(frame):
    """Convert a frame (numpy array) to base64 encoded image string"""
    # Ensure frame is in the right format for OpenCV
    if isinstance(frame, np.ndarray):
        # Handle different color formats
        if len(frame.shape) == 2:  # Grayscale
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_GRAY2RGB)
        elif frame.shape[2] == 3:  # Already RGB/BGR
            if frame.dtype != np.uint8:
                # Normalize and convert to uint8 if not already
                frame = ((frame - frame.min()) / (frame.max() - frame.min()) * 255).astype(np.uint8)
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        else:
            # Handle other formats as needed
            frame_rgb = frame
        
        # Encode as JPEG
        _, buffer = cv2.imencode('.jpg', frame_rgb)
        image_data = base64.b64encode(buffer).decode('utf-8')
        return f"data:image/jpeg;base64,{image_data}"
    else:
        raise ValueError("Frame is not a numpy array")

def extract_patient_number(name: str) -> int:
    match = re.search(r'\d+', name)
    return int(match.group()) if match else float('inf')

def get_or_create_patient_mapping(patients_by_source):
    """
    Creates or loads a mapping from source patient names to sequential IDs.
    
    Args:
        patients_by_source: Dictionary where keys are source keys (source:original_name)
                           and values are patient data
    
    Returns:
        Dictionary mapping source keys to new sequential patient IDs
    """
    if os.path.exists(PATIENT_MAPPING_FILE):
        # Load existing mapping if it exists
        try:
            with open(PATIENT_MAPPING_FILE, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"Error decoding {PATIENT_MAPPING_FILE}, creating new mapping")
    
    # Create a new mapping with randomized order
    unique_patients = list(patients_by_source.keys())
    # Shuffle the list to randomize order
    random.shuffle(unique_patients)
    
    # Create sequential mapping (Patient 1, Patient 2, etc.)
    mapping = {}
    for i, patient_key in enumerate(unique_patients):
        # Use 1-indexed patient numbers for better UX
        new_patient_id = f"Patient {i+1}"
        mapping[patient_key] = new_patient_id
    
    # Save the mapping for future use
    with open(PATIENT_MAPPING_FILE, 'w') as f:
        json.dump(mapping, f)
    
    return mapping

def save_to_csv(patients_data: List[Dict], csv_path: str):
    """
    Save patients data to CSV. Writes both dicoms and apngs.
    Adds 'kind' column ('dicom' or 'apng'). Older readers without 'kind'
    can default to 'dicom'.
    """
    headers = [
        "patientName", "originalName", "source", "dicomName", "label",
        "filepath", "frameCount", "originalPatientName", "kind"
    ]
    dirname = os.path.dirname(csv_path)
    if dirname:
        os.makedirs(dirname, exist_ok=True)

    with open(csv_path, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(headers)
        for patient in patients_data:
            # unified writer for both kinds
            for key, kind in (("dicoms", "dicom"), ("apngs", "apng")):
                items = patient.get(key, [])
                if isinstance(items, dict):
                    items = list(items.values())
                for item in items:
                    writer.writerow([
                        patient["patientName"],
                        patient.get("originalName", ""),
                        item.get("source", patient.get("source", "")),
                        item["dicomName"],
                        item.get("label", 0),
                        item.get("filepath", ""),
                        item.get("frameCount", 0),
                        item.get("originalPatientName", ""),
                        kind
                    ])
    print(f"Data saved to {csv_path}")

def load_from_csv(csv_path: str):
    if not os.path.exists(csv_path):
        print(f"CSV file {csv_path} not found")
        return []

    patients = {}
    with open(csv_path, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader)

        # Column indices (with fallbacks)
        patient_name_idx = headers.index("patientName") if "patientName" in headers else 0
        dicom_name_idx = headers.index("dicomName") if "dicomName" in headers else 1
        label_idx = headers.index("label") if "label" in headers else 2
        filepath_idx = headers.index("filepath") if "filepath" in headers else 3
        frame_count_idx = headers.index("frameCount") if "frameCount" in headers else 4
        source_idx = headers.index("source") if "source" in headers else -1
        original_name_idx = headers.index("originalName") if "originalName" in headers else -1
        original_patient_name_idx = headers.index("originalPatientName") if "originalPatientName" in headers else -1
        kind_idx = headers.index("kind") if "kind" in headers else -1

        for row in reader:
            if len(row) <= max(patient_name_idx, dicom_name_idx, label_idx):
                print(f"Skipping malformed row: {row}")
                continue

            patient_name = row[patient_name_idx]
            dicom_name = row[dicom_name_idx]
            label_str = row[label_idx]

            filepath = row[filepath_idx] if 0 <= filepath_idx < len(row) else ""
            try:
                frame_count = int(row[frame_count_idx]) if 0 <= frame_count_idx < len(row) and row[frame_count_idx].isdigit() else 0
            except:
                frame_count = 0
            source = row[source_idx] if 0 <= source_idx < len(row) else ""
            original_name = row[original_name_idx] if 0 <= original_name_idx < len(row) else ""
            original_patient_name = row[original_patient_name_idx] if 0 <= original_patient_name_idx < len(row) else ""
            kind = (row[kind_idx].strip().lower() if 0 <= kind_idx < len(row) and row[kind_idx] else "dicom")

            if patient_name not in patients:
                patients[patient_name] = {
                    "patientName": patient_name,
                    "originalName": original_name,
                    "source": source,
                    "dicoms": [],
                    "apngs": []
                }

            entry = {
                "dicomName": dicom_name,
                "label": int(label_str),
                "filepath": filepath,
                "frameCount": frame_count,
                "source": source,
                "originalPatientName": original_patient_name
            }
            if kind == "apng":
                patients[patient_name]["apngs"].append(entry)
            else:
                patients[patient_name]["dicoms"].append(entry)

    patient_list = list(patients.values())
    print(f"Loaded {len(patient_list)} patients from CSV: {csv_path}")
    return patient_list

def update_csv_with_label(patient_name: str, dicom_name: str, label: int, csv_path: str):
    """Update a specific CSV with the given label"""
    if not os.path.exists(csv_path):
        patients_data = [{
            "patientName": patient_name,
            "originalName": "",
            "source": "",
            "dicoms": [{
                "dicomName": dicom_name,
                "label": label,
                "filepath": "",
                "frameCount": 0,
                "originalPatientName": ""
            }]
        }]
        save_to_csv(patients_data, csv_path)
        return True
    
    rows = []
    found = False
    with open(csv_path, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader)
        rows.append(headers)
        
        # Determine column indices
        patient_name_idx = headers.index("patientName") if "patientName" in headers else 0
        dicom_name_idx = headers.index("dicomName") if "dicomName" in headers else 1
        label_idx = headers.index("label") if "label" in headers else 2
        
        for row in reader:
            if len(row) <= max(patient_name_idx, dicom_name_idx, label_idx):
                rows.append(row)
                continue
                
            if row[patient_name_idx] == patient_name and row[dicom_name_idx] == dicom_name:
                row[label_idx] = str(label)
                found = True
                
            rows.append(row)
    
    if not found:
        # If adding a new row, include empty fields for new columns
        new_row = [""] * len(headers)
        new_row[patient_name_idx] = patient_name
        new_row[dicom_name_idx] = dicom_name
        new_row[label_idx] = str(label)
        rows.append(new_row)
    
    with open(csv_path, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        for row in rows:
            writer.writerow(row)
    
    print(f"Updated CSV {csv_path} for {patient_name}/{dicom_name} with label {label}")
    return True

@app.post("/scan-directory")
async def scan_directory(request: ScanDirectoryRequest):
    """Scan directories for DICOM files and update user's CSV"""
    # Get username from request
    username = request.username
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    
    # Get path for user's CSV
    user_csv_path = get_user_csv_path(username)
    
    butterfly_path = request.butterfly_directory_path
    vave_path = request.vave_directory_path
    butterfly_path_2 = request.butterfly_2_directory_path 
    
    print(f"Scanning Butterfly directory: {butterfly_path}")
    print(f"Scanning Vave directory: {vave_path}")
    print(f"Scanning Butterfly 2 directory: {butterfly_path_2}")
    
    # Ensure at least one path is provided
    if not butterfly_path and not vave_path and not butterfly_path_2:
        raise HTTPException(status_code=400, detail="At least one directory path must be provided")
    
    # Validate paths
    for path, source in [(butterfly_path, "butterfly"), (vave_path, "vave"), (butterfly_path_2, "butterfly_2")]:
        if path and not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"{source.capitalize()} directory not found: {path}")
        if path and not os.path.isdir(path):
            raise HTTPException(status_code=400, detail=f"Not a directory: {path}")
    
    # Load existing CSV data (only user-specific for labels)
    user_patients = load_from_csv(user_csv_path) if os.path.exists(user_csv_path) else []
    
    # Create dictionaries for faster lookup
    user_patient_dict = {}
    for patient in user_patients:
        user_patient_dict[patient["patientName"]] = {
            "patientName": patient["patientName"],
            "dicoms": {},
            "apngs": {}
        }
        for dicom in patient.get("dicoms", []):
            user_patient_dict[patient["patientName"]]["dicoms"][dicom["dicomName"]] = dicom
        for apng in patient.get("apngs", []):
            user_patient_dict[patient["patientName"]]["apngs"][apng["dicomName"]] = apng
    
    # Process both directories and collect patients by source
    patients_by_source = {}

    # Helper function to create apng
    def is_apng_file(path: str) -> bool:
        """
        Fast APNG check: PNG signature + presence of 'acTL' chunk.
        Falls back to APNG.open() if needed.
        """
        try:
            with open(path, "rb") as f:
                sig = f.read(8)
                if sig != b"\x89PNG\r\n\x1a\n":
                    return False
                while True:
                    len_bytes = f.read(4)
                    if len(len_bytes) < 4:
                        break
                    length = int.from_bytes(len_bytes, "big", signed=False)
                    ctype = f.read(4)
                    if len(ctype) < 4:
                        break
                    if ctype == b"acTL":
                        return True
                    # skip data + crc
                    f.seek(length + 4, os.SEEK_CUR)
            return False
        except Exception:
            # Last resort: try parsing
            try:
                APNG.open(path)
                return True
            except Exception:
                return False

    def apng_frame_count(path: str) -> int:
        try:
            ap = APNG.open(path)
            return max(1, len(ap.frames))
        except Exception:
            return 1
    
    # Helper function to process a directory
    def process_directory(directory_path, source):
        if not directory_path:
            return
            
        for root, dirs, files in os.walk(directory_path):
            for file in files:
                rel_path = os.path.relpath(root, directory_path)
                if rel_path == ".":
                    continue
                parts = rel_path.split(os.sep)
                if not parts:
                    continue
                
                # The original patient name from the directory
                original_patient_name = parts[0]
                filepath = os.path.join(root, file)
                dicomName = file
                ext = os.path.splitext(file)[1].lower()

                # Create a unique key combining source and original name
                patient_key = f"{source}:{original_patient_name}"

                # Ensure structure exists (now with BOTH keys)
                if patient_key not in patients_by_source:
                    patients_by_source[patient_key] = {
                        "originalName": original_patient_name,
                        "source": source,
                        "dicoms": {},   # unchanged
                        "apngs": {}     # NEW
                    }

                # Only look at DICOMs or APNGs
                # 1) APNG path (accept .apng or .png that truly has acTL)
                if ext in (".apng", ".png"):
                    try:
                        if is_apng_file(filepath):
                            frame_count = apng_frame_count(filepath)
                            print(f"Found APNG: {original_patient_name}/{dicomName} (frames={frame_count}, source={source})")
                            patients_by_source[patient_key]["apngs"][dicomName] = {
                                "dicomName": dicomName,           # keep same field naming for now
                                "label": 0,
                                "filepath": filepath,
                                "frameCount": frame_count,
                                "source": source,
                                "originalPatientName": original_patient_name
                            }
                            continue
                        else:
                            # It's a plain PNG, and per your request we only include APNGs (skip)
                            continue
                    except Exception as e:
                        print(f"Error checking APNG {filepath}: {e}")
                        continue
                else:
                # 2) DICOM path (many DICOMs have no extension; try read unless definitely APNG)
                    try:
                        ds = pydicom.dcmread(filepath, stop_before_pixels=True)
                        if not hasattr(ds, 'SOPClassUID'):
                            # Not a valid DICOM; skip
                            continue
                        frame_count = int(ds.NumberOfFrames) if hasattr(ds, 'NumberOfFrames') else 1
                        print(f"Found DICOM: {original_patient_name}/{dicomName} (frames={frame_count}, source={source})")
                    except Exception as e:
                        # Not APNG, not DICOM -> skip
                        continue
                
                # Store DICOM info
                patients_by_source[patient_key]["dicoms"][dicomName] = {
                    "dicomName": dicomName,
                    "label": 0,
                    "filepath": filepath,
                    "frameCount": frame_count,
                    "source": source,
                    "originalPatientName": original_patient_name
                }

    # Process both directories
    if butterfly_path:
        process_directory(butterfly_path, "butterfly")
    if vave_path:
        process_directory(vave_path, "vave")
    if butterfly_path_2:
        process_directory(butterfly_path_2, "butterfly_2")
    
    # Get or create the mapping from source patients to sequential IDs
    patient_mapping = get_or_create_patient_mapping(patients_by_source)
    
    # Create a new structure with mapped patient names
    patients = {}
    
    # Create patient entry for each mapped patient
    for source_key, patient_data in patients_by_source.items():
        if source_key in patient_mapping:
            new_patient_name = patient_mapping[source_key]
            original_name = patient_data["originalName"]
            source = patient_data["source"]
            
            if new_patient_name not in patients:
                patients[new_patient_name] = {
                    "patientName": new_patient_name,
                    "originalName": original_name,
                    "source": source,
                    "dicoms": {},
                    "apngs": {}
                }
            
            # Add all DICOMs from this source patient
            for dicom_name, dicom_data in patient_data["dicoms"].items():
                # Check if this DICOM already has a label in the user's CSV
                label = 0
                original_name = dicom_data["originalPatientName"]
                
                # Complex lookup: try to find this DICOM in the user's CSV
                # We need to match both the original patient name and the DICOM name
                for user_patient_name, user_patient in user_patient_dict.items():
                    for user_dicom_name, user_dicom in user_patient["dicoms"].items():
                        if (user_dicom.get("originalPatientName") == original_name and 
                            user_dicom_name == dicom_name and
                            user_dicom.get("source") == source):
                            label = user_dicom.get("label", 0)
                            print(f"Found existing user label for {original_name}/{dicom_name} (source: {source}): {label}")
                            break
                
                # Update the label and add to the new patients dictionary
                dicom_data["label"] = label
                patients[new_patient_name]["dicoms"][dicom_name] = dicom_data
            for apng_name, apng_data in patient_data.get("apngs", {}).items():
                label = 0
                original_name = apng_data["originalPatientName"]
                # If you later add APNG labels, this will pick them up
                for _, user_patient in user_patient_dict.items():
                    for user_apng_name, user_apng in user_patient.get("apngs", {}).items():
                        if (user_apng.get("originalPatientName") == original_name and
                            user_apng_name == apng_name and
                            user_apng.get("source") == source):
                            label = user_apng.get("label", 0)
                            break
                apng_data["label"] = label
                patients[new_patient_name]["apngs"][apng_name] = apng_data
    
    # Convert to list format for the response
    patient_list = []
    for patient_name, data in patients.items():
        patient_list.append({
            "patientName": patient_name,
            "originalName": data.get("originalName", ""),
            "source": data.get("source", ""),
            "dicoms": list(data["dicoms"].values()),
            "apngs": list(data.get("apngs", {}).values())   # NEW
        })

    # Sort the patient list - now we sort by the new sequential IDs
    def extract_patient_number_from_mapped(patient):
        # Extract number from "Patient X" format
        match = re.search(r'\d+', patient["patientName"])
        return int(match.group()) if match else float('inf')
    
    patient_list_sorted = sorted(patient_list, key=extract_patient_number_from_mapped)

    # Save to main CSV (structure with filepath info) - this serves as the template for new users
    save_to_csv(patient_list_sorted, MAIN_CSV_FILE_PATH)
    
    # For the current user, preserve their labels if they had any
    save_to_csv(patient_list_sorted, user_csv_path)

    # Remove source info before sending to frontend
    for patient in patient_list_sorted:
        for dicom in patient.get("dicoms", []):
            dicom.pop("source", None)
        for apng in patient.get("apngs", []):
            apng.pop("source", None)
                
    print(f"Returning {len(patient_list_sorted)} patients with metadata")
    return {"patients": patient_list_sorted}

def _pil_to_data_uri(pil_img, mime="image/png") -> str:
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:{mime};base64,{data}"

@app.post("/fetch-patient-dicoms")
async def fetch_patient_dicoms(request: PatientDicomsRequest):
    """
    Fetch media for a specific patient using the user's CSV.
    Returns two lists: dicoms[] and apngs[], each item has images[] just like DICOMs.
    """
    patient_name = request.patientName
    username = request.username

    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    user_csv_path = get_user_csv_path(username)
    print(f'Fetching media for patient {patient_name} for user {username}')

    csv_patients = load_from_csv(user_csv_path)
    dicom_items = []
    apng_items  = []

    for patient in csv_patients:
        if patient["patientName"] != patient_name:
            continue

        # ---------- DICOMs (existing logic) ----------
        for dicom in patient.get("dicoms", []):
            dicomName = dicom["dicomName"]
            filepath  = dicom.get("filepath")
            label     = dicom.get("label", 0)

            if not (filepath and os.path.exists(filepath)):
                dicom_items.append({"dicomName": dicomName, "label": label, "images": [], "error": "Missing file"})
                continue

            try:
                ds = pydicom.dcmread(filepath)
                images = []

                # Is this a video-encoded DICOM?
                is_video_dicom = False
                if hasattr(ds.file_meta, 'TransferSyntaxUID'):
                    ts_uid = str(ds.file_meta.TransferSyntaxUID)
                    if ts_uid == '1.2.840.10008.1.2.4.102' or 'MPEG-4' in ds.file_meta.TransferSyntaxUID.name:
                        is_video_dicom = True

                if is_video_dicom:
                    print(f"Processing video DICOM: {dicomName}")
                    try:
                        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=True) as temp_file:
                            temp_file.write(next(generate_pixel_data_frame(ds.PixelData)))
                            temp_file.flush()

                            cap = cv2.VideoCapture(temp_file.name)
                            if cap.isOpened():
                                frame_count = 0
                                while True:
                                    ret, frame = cap.read()
                                    if not ret:
                                        break
                                    image_data = convert_frame_to_base64(frame)  # your existing encoder
                                    images.append({
                                        "id": f"{dicomName}-{frame_count+1}",
                                        "src": image_data
                                    })
                                    frame_count += 1
                                cap.release()
                            else:
                                raise Exception("Could not open video from DICOM")
                    except Exception as video_error:
                        print(f"Error extracting video frames: {video_error}")
                        images = []
                else:
                    # Standard non-video DICOMs
                    try:
                        pixel_array = ds.pixel_array
                        if len(pixel_array.shape) > 2:
                            frames = [pixel_array[i] for i in range(pixel_array.shape[0])]
                        else:
                            frames = [pixel_array]
                        images = [{"id": f"{dicomName}-{i+1}", "src": convert_frame_to_base64(frame)} for i, frame in enumerate(frames)]
                    except Exception as pixel_error:
                        print(f"Error processing pixel data: {pixel_error}")
                        images = []

                dicom_items.append({"dicomName": dicomName, "label": label, "images": images})
            except Exception as e:
                print(f"Error reading DICOM: {e}")
                dicom_items.append({"dicomName": dicomName, "label": label, "images": [], "error": str(e)})

        # ---------- APNGs (new, frame-by-frame like DICOM) ----------
        for apng_entry in patient.get("apngs", []):
            apng_name = apng_entry["dicomName"]  # keeping same field name for consistency
            filepath  = apng_entry.get("filepath")
            label     = apng_entry.get("label", 0)

            if not (filepath and os.path.exists(filepath)):
                apng_items.append({"dicomName": apng_name, "label": label, "images": [], "error": "Missing file"})
                continue

            try:
                ap = APNG.open(filepath)
                images = []
                idx = 0
                for png, ctrl in ap.frames:
                    try:
                        pil_img = Image.open(io.BytesIO(png.to_bytes()))
                        if pil_img.mode not in ("RGB", "RGBA", "L"):
                            pil_img = pil_img.convert("RGBA")
                        src = _pil_to_data_uri(pil_img, mime="image/png")

                        img_obj = {"id": f"{apng_name}-{idx+1}", "src": src}
                        # Optional: attach original per-frame delay if available
                        try:
                            num = getattr(ctrl, "delay_num", getattr(ctrl, "delay", None))
                            den = getattr(ctrl, "delay_den", None) or 100
                            if num is not None:
                                img_obj["delayMs"] = int(1000 * float(num) / float(den))
                        except Exception:
                            pass

                        images.append(img_obj)
                        idx += 1
                    except Exception as frame_err:
                        print(f"Error decoding APNG frame for {apng_name}: {frame_err}")
                        continue

                apng_items.append({"dicomName": apng_name, "label": label, "images": images})
            except Exception as e:
                print(f"Error reading APNG {filepath}: {e}")
                apng_items.append({"dicomName": apng_name, "label": label, "images": [], "error": str(e)})

        break  # found the patient we wanted

    if not dicom_items and not apng_items:
        raise HTTPException(status_code=404, detail=f"No DICOMs or APNGs found for patient: {patient_name}")

    # Return them in separate arrays to avoid index/shape confusion on the frontend
    return {
        "patientName": patient_name,
        "dicoms": dicom_items,
        "apngs": apng_items
    }

@app.get("/fetch-csv")
async def fetch_csv(username: str = None):
    """Fetch CSV data for a specific user or the main CSV if no username is provided"""
    if not username:
        raise HTTPException(status_code=400, detail="Username parameter is required")
    
    # Get path for user's CSV
    user_csv_path = get_user_csv_path(username)
    
    if not os.path.exists(user_csv_path):
        # If user CSV doesn't exist but main does, copy structure from main but with all labels set to 0
        if os.path.exists(MAIN_CSV_FILE_PATH):
            main_patients = load_from_csv(MAIN_CSV_FILE_PATH)
            # Set all labels to 0
            for patient in main_patients:
                for dicom in patient["dicoms"]:
                    dicom["label"] = 0
            # Save this clean version to the user's CSV
            save_to_csv(main_patients, user_csv_path)
            return {"patients": main_patients}
        return {"patients": []}
    
    # Load from user's CSV
    return {"patients": load_from_csv(user_csv_path)}

@app.post("/update-csv")
async def update_csv(update_request: UpdateRequest):
    """Update a label in both the main CSV and user-specific CSV"""
    try:
        username = update_request.username
        
        if not username:
            raise HTTPException(status_code=400, detail="Username is required")
        
        # Get path for user's CSV
        user_csv_path = get_user_csv_path(username)
        
        # Update only the user's CSV
        user_success = update_csv_with_label(
            update_request.patientName, 
            update_request.dicomName, 
            update_request.label,
            user_csv_path
        )
        
        return {"success": user_success}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
@app.get("/reset-csv")
async def reset_csv(username: str = None, delete_all: bool = False):
    """Delete user's CSV file and optionally all application data"""
    if not username:
        raise HTTPException(status_code=400, detail="Username parameter is required")
    
    try:
        # Get path for user's CSV
        user_csv_path = get_user_csv_path(username)
        
        if delete_all:
            # Delete main CSV, patient mapping, and user accounts if requested
            if os.path.exists(MAIN_CSV_FILE_PATH):
                os.remove(MAIN_CSV_FILE_PATH)
                print(f"Deleted main CSV file: {MAIN_CSV_FILE_PATH}")
            
            if os.path.exists(PATIENT_MAPPING_FILE):
                os.remove(PATIENT_MAPPING_FILE)
                print(f"Deleted patient mapping file: {PATIENT_MAPPING_FILE}")
            
            if os.path.exists(ACCOUNTS_CSV_PATH):
                os.remove(ACCOUNTS_CSV_PATH)
                print(f"Deleted accounts CSV file: {ACCOUNTS_CSV_PATH}")
            
            # Delete all user CSV files
            for file in os.listdir():
                if file.startswith("user_") and file.endswith("_labels.csv"):
                    os.remove(file)
                    print(f"Deleted user CSV file: {file}")
                    
            return {"success": True, "message": "All application data has been deleted successfully"}
        
        # Just delete the user's CSV file
        if os.path.exists(user_csv_path):
            os.remove(user_csv_path)
            return {"success": True, "message": f"CSV file for user {username} deleted successfully"}
        
        return {"success": True, "message": f"No CSV file found for user {username}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
@app.get("/accounts")
async def get_accounts():
    """Get all user accounts"""
    accounts = load_accounts()
    return {"accounts": accounts}

@app.post("/accounts")
async def create_account(request: AccountRequest):
    """Create a new user account"""
    username = request.username.strip()
    
    if not username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    
    success = save_account(username)
    if not success:
        raise HTTPException(status_code=409, detail=f"Account '{username}' already exists")
    
    return {"success": True, "username": username}

@app.post("/login")
async def login(request: LoginRequest):
    """Login with username"""
    username = request.username.strip()
    accounts = load_accounts()
    
    # Check if account exists
    account_exists = any(account["username"] == username for account in accounts)
    if not account_exists:
        # Auto-create the account if it doesn't exist
        save_account(username)
    
    # If a main CSV exists but no user-specific CSV, create one with all labels set to 0
    user_csv_path = get_user_csv_path(username)
    if os.path.exists(MAIN_CSV_FILE_PATH) and not os.path.exists(user_csv_path):
        main_patients = load_from_csv(MAIN_CSV_FILE_PATH)
        # Reset all labels to 0
        for patient in main_patients:
            for dicom in patient["dicoms"]:
                dicom["label"] = 0
        # Save this clean version to the user's CSV
        save_to_csv(main_patients, user_csv_path)
    
    return {"success": True, "username": username}

# ----- Mount static files AFTER all API endpoints have been added -----
# This ensures your POST endpoints are not shadowed by the StaticFiles mount.
app.mount("/", StaticFiles(directory="../frontend/build", html=True), name="static")