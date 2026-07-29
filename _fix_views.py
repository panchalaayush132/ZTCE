import re

filepath = r'd:\ZTCE\backend\engine\views.py'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix remaining patterns:
# 1. Operator_file -> operator_file (variable)
# 2. Operator_dir -> operator_dir (variable)
# 3. Operator__session -> operator__session (ORM lookup)
# 4. Operator__xxx -> operator__xxx (ORM lookups)
# 5. "Operators" in string literals -> "operators"
# 6. "all Operators" -> "all operators" in comments

# Fix ORM double-underscore lookups
content = re.sub(r'Operator__', 'operator__', content)

# Fix variable names (not class name)
content = re.sub(r'Operator_file', 'operator_file', content)
content = re.sub(r'Operator_dir', 'operator_dir', content)
content = re.sub(r'Operator_runtime', 'operator_runtime', content)
content = re.sub(r'Operator_workspace', 'operator_workspace', content)
content = re.sub(r'Operator_data', 'operator_data', content)

# Fix string literals with "Operators"
content = content.replace('all Operators', 'all operators')
content = content.replace('each Operator', 'each operator')
content = content.replace('the Operator', 'the operator')
content = content.replace('a Operator', 'an operator')
content = content.replace('for Operator', 'for operator')
content = content.replace('every Operator', 'every operator')

# Verify
try:
    compile(content, filepath, 'exec')
    print("Syntax OK!")
except SyntaxError as e:
    print(f"Syntax Error at line {e.lineno}: {e.msg}")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

# Final count
count = 0
for i, line in enumerate(content.split('\n')):
    indent = len(line) - len(line.lstrip())
    s = line.strip()
    if indent >= 8 and 'Operator' in s:
        if not any(x in s for x in ['OperatorFile', 'OperatorSerializer', 'Operator.objects', 'OperatorViewSet', 'operator_obj']):
            count += 1
            if count <= 10:
                print(f"  Line {i+1}: {s[:120]}")

print(f"\nRemaining: {count}")
