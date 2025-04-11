import sys
import os
import tempfile
import subprocess
import shutil
import time

# msvcrt is only available on Windows
try:
    import msvcrt
except ImportError:
    msvcrt = None

def create_temp_venv(requirements_file):
    # Create a temporary directory for the virtual environment.
    temp_dir = tempfile.mkdtemp(prefix="temp_env_")
    subprocess.check_call([sys.executable, "-m", "venv", temp_dir])
    # Determine the path to the virtual environment's Python executable.
    venv_python = (
        os.path.join(temp_dir, "Scripts", "python.exe")
        if os.name == "nt"
        else os.path.join(temp_dir, "bin", "python")
    )
    # Upgrade pip and install requirements.
    subprocess.check_call([venv_python, "-m", "pip", "install", "--upgrade", "pip"])
    subprocess.check_call([venv_python, "-m", "pip", "install", "-r", requirements_file])
    return temp_dir, venv_python

def run_uvicorn(venv_python):
    # Start Uvicorn from the temporary virtual environment.
    # The working directory is set to the backend folder.
    process = subprocess.Popen(
        [venv_python, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"],
        cwd=os.path.dirname(os.path.abspath(__file__))
    )
    return process

def wait_for_exit_key():
    """
    Wait until ESC is pressed or until a KeyboardInterrupt is raised.
    This works on Windows using msvcrt.
    """
    if msvcrt is None:
        print("msvcrt module is unavailable; press Ctrl+C to exit.")
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            return
    else:
        print("Press ESC or Ctrl+C to exit...")
        try:
            while True:
                if msvcrt.kbhit():
                    key = msvcrt.getch()
                    # ESC key is represented as b'\x1b'
                    if key == b'\x1b':
                        break
                time.sleep(0.1)
        except KeyboardInterrupt:
            # If Ctrl+C is pressed, a KeyboardInterrupt is raised.
            pass

def main():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    requirements_file = os.path.join(current_dir, "requirements.txt")
    
    print("Creating temporary virtual environment...")
    temp_env_dir, venv_python = create_temp_venv(requirements_file)
    
    try:
        print("Starting Uvicorn server...")
        uvicorn_process = run_uvicorn(venv_python)
        # Wait for the user to press ESC or trigger KeyboardInterrupt (Ctrl+C)
        wait_for_exit_key()
        print("Exit key pressed. Terminating Uvicorn server...")
        uvicorn_process.terminate()
        uvicorn_process.wait()
    except KeyboardInterrupt:
        print("KeyboardInterrupt received. Terminating server...")
        uvicorn_process.terminate()
        uvicorn_process.wait()
    finally:
        print("Cleaning up temporary environment...")
        shutil.rmtree(temp_env_dir)

if __name__ == "__main__":
    main()
