import fs from 'fs';
import path from 'path';

function fixFile(filePath: string) {
    const p = path.resolve(filePath);
    let code = fs.readFileSync(p, 'utf-8');
    
    // Replace React.FormEvent, React.ChangeEvent, React.DragEvent etc with standard import if needed,
    // or just prepend import React from 'react'; if not exists.
    if (!code.includes("import React ") && !code.includes("import React,")) {
        code = `import React from 'react';\n` + code;
    }

    fs.writeFileSync(p, code, 'utf-8');
}

const filesToFix = [
    'src/App.tsx',
    'src/components/ConfirmModal.tsx',
    'src/components/DraggableOrb.tsx',
    'src/views/AlertsView.tsx',
    'src/views/BillingView.tsx',
    'src/views/DataUploadView.tsx',
    'src/views/PortalView.tsx',
    'src/views/ReportsView.tsx'
];

filesToFix.forEach(fixFile);

// Fix ErrorBoundary separately
const ebPath = path.resolve('src/components/ErrorBoundary.tsx');
let ebCode = fs.readFileSync(ebPath, 'utf-8');
if (!ebCode.includes("constructor(props")) {
    ebCode = ebCode.replace(
        `  public state: State = {`,
        `  constructor(props: Props) {\n    super(props);\n  }\n\n  public state: State = {`
    );
    fs.writeFileSync(ebPath, ebCode, 'utf-8');
}

console.log('Fixed imports');
