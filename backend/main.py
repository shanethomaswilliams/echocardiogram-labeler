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
    username: str

class UpdateRequest(BaseModel):
    patientName: str
    dicomName: str
    label: int
    username: str

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
    """Save patients data to a specific CSV file path"""
    headers = ["patientName", "originalName", "source", "dicomName", "label", "filepath", "frameCount", "originalPatientName"]
    
    # Ensure directory exists if the csv_path includes a directory
    dirname = os.path.dirname(csv_path)
    if dirname:  # Only create directories if there's actually a directory part
        os.makedirs(dirname, exist_ok=True)
    
    with open(csv_path, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(headers)
        for patient in patients_data:
            for dicom in patient["dicoms"]:
                writer.writerow([
                    patient["patientName"],
                    patient.get("originalName", ""),
                    patient.get("source", ""),
                    dicom["dicomName"],
                    dicom.get("label", 0),
                    dicom.get("filepath", ""),
                    dicom.get("frameCount", 0),
                    dicom.get("originalPatientName", "")
                ])
    print(f"Data saved to {csv_path}")

def load_from_csv(csv_path: str):
    """Load patients data from a specific CSV file path"""
    if not os.path.exists(csv_path):
        print(f"CSV file {csv_path} not found")
        return []
    patients = {}
    with open(csv_path, 'r', newline='') as csvfile:
        reader = csv.reader(csvfile)
        headers = next(reader)
        
        # Determine column indices based on headers
        patient_name_idx = headers.index("patientName") if "patientName" in headers else 0
        dicom_name_idx = headers.index("dicomName") if "dicomName" in headers else 1
        label_idx = headers.index("label") if "label" in headers else 2
        filepath_idx = headers.index("filepath") if "filepath" in headers else 3
        frame_count_idx = headers.index("frameCount") if "frameCount" in headers else 4
        source_idx = headers.index("source") if "source" in headers else -1
        original_name_idx = headers.index("originalName") if "originalName" in headers else -1
        original_patient_name_idx = headers.index("originalPatientName") if "originalPatientName" in headers else -1
        
        for row in reader:
            if len(row) <= max(patient_name_idx, dicom_name_idx, label_idx):
                print(f"Skipping malformed row: {row}")
                continue
            
            patient_name = row[patient_name_idx]
            dicom_name = row[dicom_name_idx]
            label_str = row[label_idx]
            
            # Get optional fields if they exist
            filepath = row[filepath_idx] if filepath_idx >= 0 and filepath_idx < len(row) else ""
            
            try:
                frame_count = int(row[frame_count_idx]) if frame_count_idx >= 0 and frame_count_idx < len(row) and row[frame_count_idx].isdigit() else 0
            except:
                frame_count = 0
                
            source = row[source_idx] if source_idx >= 0 and source_idx < len(row) else ""
            original_name = row[original_name_idx] if original_name_idx >= 0 and original_name_idx < len(row) else ""
            original_patient_name = row[original_patient_name_idx] if original_patient_name_idx >= 0 and original_patient_name_idx < len(row) else ""
            
            if patient_name not in patients:
                patients[patient_name] = {
                    "patientName": patient_name,
                    "originalName": original_name,
                    "source": source,
                    "dicoms": []
                }
                
            patients[patient_name]["dicoms"].append({
                "dicomName": dicom_name,
                "label": int(label_str),
                "filepath": filepath,
                "frameCount": frame_count,
                "source": source,
                "originalPatientName": original_patient_name
            })
            
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
    
    print(f"Scanning Butterfly directory: {butterfly_path}")
    print(f"Scanning Vave directory: {vave_path}")
    
    # Ensure at least one path is provided
    if not butterfly_path and not vave_path:
        raise HTTPException(status_code=400, detail="At least one directory path must be provided")
    
    # Validate paths
    for path, source in [(butterfly_path, "butterfly"), (vave_path, "vave")]:
        if path and not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"{source.capitalize()} directory not found: {path}")
        if path and not os.path.isdir(path):
            raise HTTPException(status_code=400, detail=f"Not a directory: {path}")
    
    # Load existing CSV data (only user-specific for labels)
    user_patients = load_from_csv(user_csv_path) if os.path.exists(user_csv_path) else []
    
    # Create dictionaries for faster lookup
    user_patient_dict = {}
    for patient in user_patients:
        user_patient_dict[patient["patientName"]] = {"patientName": patient["patientName"], "dicoms": {}}
        for dicom in patient["dicoms"]:
            user_patient_dict[patient["patientName"]]["dicoms"][dicom["dicomName"]] = dicom
    
    # Process both directories and collect patients by source
    patients_by_source = {}
    
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
                
                # Create a unique key combining source and original name
                # This ensures patients with same name from different sources are treated separately
                patient_key = f"{source}:{original_patient_name}"
                
                print(f"Found potential DICOM: {original_patient_name}/{dicomName} (source: {source})")
                
                if patient_key not in patients_by_source:
                    patients_by_source[patient_key] = {
                        "originalName": original_patient_name,
                        "source": source,
                        "dicoms": {}
                    }
                
                # Check for existing label only in user's CSV
                # This is trickier now with the mapping - we'll handle it after mapping
                label = 0
                
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
                
                # Store with source information
                patients_by_source[patient_key]["dicoms"][dicomName] = {
                    "dicomName": dicomName,
                    "label": label,
                    "filepath": filepath,
                    "frameCount": frame_count,
                    "source": source,
                    "originalPatientName": original_patient_name  # Store original name
                }
    
    # Process both directories
    if butterfly_path:
        process_directory(butterfly_path, "butterfly")
    if vave_path:
        process_directory(vave_path, "vave")
    
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
                    "dicoms": {}
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
    
    # Convert to list format for the response
    patient_list = []
    for patient_name, data in patients.items():
        patient_list.append({
            "patientName": patient_name,
            "originalName": data.get("originalName", ""),
            "source": data.get("source", ""),
            "dicoms": list(data["dicoms"].values())
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
        for dicom in patient["dicoms"]:
            if "source" in dicom:
                del dicom["source"]
                
    print(f"Returning {len(patient_list_sorted)} patients with metadata")
    return {"patients": patient_list_sorted}

@app.post("/fetch-patient-dicoms")
async def fetch_patient_dicoms(request: PatientDicomsRequest):
    """Fetch DICOM images for a specific patient using user's CSV"""
    patient_name = request.patientName
    username = request.username
    
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    
    # Get path for user's CSV
    user_csv_path = get_user_csv_path(username)
    
    print(f'Fetching DICOMs for patient {patient_name} for user {username}')
    
    # Load from user's CSV
    csv_patients = load_from_csv(user_csv_path)
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
                        images = []
                        
                        # Check if this is a video-encoded DICOM (MPEG-4 AVC/H.264)
                        is_video_dicom = False
                        if hasattr(ds.file_meta, 'TransferSyntaxUID'):
                            ts_uid = str(ds.file_meta.TransferSyntaxUID)
                            if ts_uid == '1.2.840.10008.1.2.4.102' or 'MPEG-4' in ds.file_meta.TransferSyntaxUID.name:
                                is_video_dicom = True
                        
                        if is_video_dicom:
                            print(f"Processing video DICOM: {dicomName}")
                            
                            # Use the video extraction technique
                            try:
                                # Extract frames from the video DICOM
                                with tempfile.NamedTemporaryFile(suffix='.mp4', delete=True) as temp_file:
                                    # Extract the encapsulated pixel data to the temp file
                                    temp_file.write(next(generate_pixel_data_frame(ds.PixelData)))
                                    temp_file.flush()
                                    
                                    # Open with OpenCV
                                    cap = cv2.VideoCapture(temp_file.name)
                                    
                                    if cap.isOpened():
                                        frame_count = 0
                                        while True:
                                            ret, frame = cap.read()
                                            if not ret:
                                                break
                                            
                                            # Convert frame to base64
                                            image_data = convert_frame_to_base64(frame)
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
                            # Standard approach for non-video DICOMs
                            try:
                                pixel_array = ds.pixel_array
                                frames = [pixel_array[i] for i in range(pixel_array.shape[0])] if len(pixel_array.shape) > 2 else [pixel_array]
                                images = [{"id": f"{dicomName}-{i+1}", "src": convert_frame_to_base64(frame)} for i, frame in enumerate(frames)]
                            except Exception as pixel_error:
                                print(f"Error processing pixel data: {pixel_error}")
                                images = []
                        
                        patient_dicoms.append({"dicomName": dicomName, "label": label, "images": images})
                    except Exception as e:
                        print(f"Error reading DICOM: {e}")
                        patient_dicoms.append({"dicomName": dicomName, "label": label, "images": [], "error": str(e)})
            break
    
    if not patient_dicoms:
        raise HTTPException(status_code=404, detail=f"No DICOMs found for patient: {patient_name}")
    
    return {"patientName": patient_name, "dicoms": patient_dicoms}

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