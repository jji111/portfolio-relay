import ast

# 1. 우리가 분석할 파이썬 코드 (텍스트)
sample_code = """
for i in range(3):
    if i == 1:
        print("Hello")
"""

print("--- 분석할 코드 ---")
print(sample_code)
print("--- AST 부품(노드) 분석 결과 ---")

# 2. 텍스트 코드를 AST 도면(트리)으로 변환
tree = ast.parse(sample_code)

# 3. 도면에 쓰인 부품 종류와 개수를 셀 바구니 준비
node_counts = {}

# 4. 트리의 모든 가지를 샅샅이 뒤집니다 (walk)
for node in ast.walk(tree):
    # 부품의 이름(타입)을 가져옵니다 (예: 'For', 'If', 'Print')
    node_name = type(node).__name__
    node_counts[node_name] = node_counts.get(node_name, 0) + 1

# 5. 결과 출력
for name, count in node_counts.items():
    print(f"- {name}: {count}개 사용됨")