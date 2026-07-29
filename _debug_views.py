import re

with open(r'd:\ZTCE\backend\engine\views.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Find all def names with @action decorator context
lines = content.split('\n')
for i, line in enumerate(lines):
    if '@action' in line or 'url_path' in line:
        print(f"Line {i+1}: {line.strip()}")

print("\n--- OperatorViewSet methods ---")
idx = content.index('class OperatorViewSet')
end_idx = content.index('\nclass ', idx + 1)
chunk = content[idx:end_idx]
defs = re.findall(r'def (\w+)', chunk)
print(defs)

# Check what add_student became
print("\n--- Searching for 'add_' patterns ---")
for m in re.finditer(r'def (add_\w+)', content):
    print(f"  Found: {m.group(1)}")

# Check url_path patterns
print("\n--- URL paths ---")
for m in re.finditer(r"url_path='([^']+)'", content):
    print(f"  {m.group(1)}")
