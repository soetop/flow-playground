import prettier from 'prettier';
import parserBabel from 'prettier/parser-babel';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Project } from 'api/apollo/generated/graphql';

import contractUnitTestTemplate from '../templates/js/contractUnitTest.hbs';

export const getNameByAddress = (address: string) => {
  const addressBook: any = {
    '0x01': 'Alice',
    '0x02': 'Bob',
    '0x03': 'Charlie',
    '0x04': 'Dave',
  };

  return addressBook[address];
};

export const getImports = (
  template: string,
): { name: string; address: string }[] => {
  const regexp = /(?:import\s*)([\w\d]*)(?:\s*from\s*)(0x[\d\w]*)/gm;
  const groups = template.matchAll(regexp);

  const result = [];
  for (let group of groups) {
    result.push({
      name: group[1],
      address: group[2],
    });
  }

  return result;
};

export const getAccountCalls = (template: string) => {
  const matches = template.match(/(?:getAccount\()(0x.*)(?:\))/g);
  if (matches) {
    return matches.map((item: string) => item.match(/0x[\w\d]*/g)[0]).sort();
  }
  return [];
};

export const filterExisting = (accounts: string[]): string[] => {
  return ['0x01', '0x02', '0x03', '0x04'].filter(
    (item) => !accounts.includes(item),
  );
};

export const getFullAccountList = (
  accounts: string[],
  signersAmount?: number,
): string[] => {
  if (accounts.length >= signersAmount) {
    return accounts;
  }

  const available = filterExisting(accounts);
  const fullList = [...accounts];
  let shift = 0;
  while (fullList.length < signersAmount) {
    fullList.push(available[shift]);
    shift += 1;
  }

  return fullList.sort();
};

export const generateGetAccounts = (accounts: string[]) => {
  if (accounts.length > 0) {
    let result = accounts.reduce((acc, item) => {
      const name = getNameByAddress(item);
      acc = acc + `const ${name} = await getAccountAddress("${name}")\n`;
      return acc;
    }, '');
    result += '\n';

    return result;
  }
  return '';
};

export const generateCodeReplacement = (accounts: string[]) => {
  if (accounts.length > 0) {
    return `
    code = code.replace(/(?:getAccount\\()(0x.*)(?:\\))/g,(_, match ) => {
    const accounts = {
      ${accounts
        .map((account) => `"${account}" : ${getNameByAddress(account)}`)
        .join('\n')}
    }
    return accounts[match]
  })
  `;
  }

  return '';
};

export const generateAddressMap = (
  addressMap: { name: string; address: string }[],
) => {
  if (addressMap.length > 0) {
    let result = '\n';
    result += addressMap
      .map(
        (item) =>
          `const ${item.name} = await getContractAddress("${item.name}");\n`,
      )
      .join('');
    result += '\n';
    result += 'const addressMap = {\n';
    result += addressMap.reduce((acc, item, i: number) => {
      const lastItem = i === addressMap.length - 1;
      return acc + `${item.name}${lastItem ? '\n' : ',\n'}`;
    }, '');
    result += '}';

    return result;
  }
  return '';
};

export const getArgumentsFromTemplate = (template: string) => {
  const pattern = /(?:transaction\s*\()(.*)(?:\).*)|(?:fun main\()(.*)(?:\).*)/g;
  const result = pattern.exec(template);

  if (result) {
    const match = result[1] || result[2];
    if (match) {
      return match.split(',').map((pair) => {
        const [name, type] = pair.replace(/\s/g, '').split(':');
        return { name, type };
      });
    }
    return [];
  }

  return [];
};

export const getDefaultValueForType = (type: string) => {
  const values: { [index: string]: number | string } = {
    Int: 1337,
    Int8: 8,
    Int16: 16,
    Int32: 32,
    UInt: 1337,
    UInt8: 8,
    UInt16: 16,
    UInt32: 32,
    UFix64: 1.0,
    String: 'Hello',
    Address: `"0x0ae53cb6e3f42a79"`, // default address for FlowToken on Emulator
  };

  return values[type];
};

export const zipArguments = (
  argumentsList: { name: string; type: string }[],
) => {
  return argumentsList.reduce(
    (acc: any, item: { name: string; type: string }) => {
      const defaultValue = getDefaultValueForType(item.type);
      if (acc.length === 0) {
        acc.push({
          values: [defaultValue],
          type: item.type,
        });
      } else {
        const current = acc[acc.length - 1];
        if (current.type === item.type) {
          current.values.push(defaultValue);
        } else {
          acc.push({
            values: [defaultValue],
            type: item.type,
          });
        }
      }

      return acc;
    },
    [],
  );
};

export const generateArgumentsCode = (argumentsList: any) => {
  if (argumentsList.length > 0) {
    let result = `const args = [
      ${argumentsList.map((item: { values: any[]; type: string }) => {
        return `[${item.values.join(',')}, types.${item.type}]`;
      })}
    ]`;
    return result;
  }

  return '';
};

export const getSignersAmount = (template: string): number => {
  const match = /(?:prepare.*\()(.*)(?:\)\s*)/g.exec(template)[1];
  return match ? match.replace(/\s/g, '').split(',').length : 0;
};

export const generateSignersCode = (
  amount: number,
  accounts: string[],
): string => {
  if (amount > 0) {
    return `const signers = [${accounts
      .map((account) => getNameByAddress(account))
      .join(',')}]`;
  }
  return '';
};

export const getContractName = (template: string) => {
  const match = template.match(/(?:contract\s*)([\d\w]*)(?:\s*{)/);
  if (match) {
    return match[1];
  }
  return '';
};

export const generateContractTarget = (toAddress: string) => {
  return `
    const to = getAccountAddress("${getNameByAddress(toAddress)}")
  `;
};

/*
  Script Generation Process
  - Gather Data
    - get list of imports
    - get list of arguments
    - get expected result type
    - get list of "getAccount" calls, then add new addressed to account list

  - Generate Code
    - generate getContractAddress($name) from list of imports
    - generate "getAccountAddress($name)" calls from account list
    - generate argument creation from list of arguments
      - provide meaningful default values
      - add comment that those values shall be updated
    - generate "executeScript" call
    - generate basic expectancy test (no errors)
    - generate mockup expectancy test based on result type
* */
export const replaceScriptTemplate = (scriptName: string, template: string) => {
  const imports = getImports(template);
  const argumentsList = getArgumentsFromTemplate(template);
  const zippedArguments = zipArguments(argumentsList);
  const argumentsCode = generateArgumentsCode(zippedArguments);

  const addressMap = generateAddressMap(imports);

  const accounts = getAccountCalls(template);
  const accountsCode = generateGetAccounts(accounts);
  const replacementCode = generateCodeReplacement(accounts);

  let result = `test("test script template ##SCRIPT-NAME##", async () => {
      // ##ADDRESS-MAP##
      
      const code = await getScriptCode({
        name: "##SCRIPT-NAME##", 
        // ##ADDRESS-MAP-CONDITIONAL##
      });
     
      // ##ARGUMENTS##
      
      // ##GET-ACCOUNTS##
            
      // ##CODE-REPLACEMENT##    
        
      const result = await executeScript({
        code, 
        // ##ARGS-CONDITIONAL##
      });
      
      // Add your expectations here
      expect().toBe();
    });
  `.replace(/##SCRIPT-NAME##/g, scriptName);

  if (addressMap.length > 0) {
    result = result.replace(/\/\/ ##ADDRESS-MAP##/, addressMap);
    result = result.replace(/\/\/ ##ADDRESS-MAP-CONDITIONAL##/, 'addressMap');
  } else {
    result = result.replace(/\/\/ ##ADDRESS-MAP##/, '');
    result = result.replace(/\/\/ ##ADDRESS-MAP-CONDITIONAL##/, '');
  }

  if (argumentsCode.length > 0) {
    result = result.replace(/\/\/ ##ARGUMENTS##/, argumentsCode);
    result = result.replace(/\/\/ ##ARGS-CONDITIONAL##/, 'args');
  } else {
    result = result.replace(/\/\/ ##ARGUMENTS##/, '');
    result = result.replace(/\/\/ ##ARGS-CONDITIONAL##/, '');
  }

  if (accountsCode.length > 0) {
    result = result.replace(/\/\/ ##GET-ACCOUNTS##/, accountsCode);
  } else {
    result = result.replace(/\/\/ ##GET-ACCOUNTS##/, '');
  }

  if (replacementCode.length > 0) {
    result = result.replace(/\/\/ ##CODE-REPLACEMENT##/, replacementCode);
  } else {
    result = result.replace(/\/\/ ##CODE-REPLACEMENT##/, '');
  }

  return prettier.format(result, { parser: 'babel', plugins: [parserBabel] });
};

export const replaceTransactionTemplate = (
  scriptName: string,
  template: string,
) => {
  const imports = getImports(template);
  const argumentsList = getArgumentsFromTemplate(template);
  const zippedArguments = zipArguments(argumentsList);
  const argumentsCode = generateArgumentsCode(zippedArguments);

  const addressMap = generateAddressMap(imports);

  const signersAmount = getSignersAmount(template);
  const accounts = getAccountCalls(template);
  const fullAccountList = getFullAccountList(accounts, signersAmount);

  const accountsCode = generateGetAccounts(fullAccountList);
  const replacementCode = generateCodeReplacement(accounts);
  const signersCode = generateSignersCode(signersAmount, fullAccountList);

  let result = `test("test transaction template ##TX-NAME##", async () => {
      // ##ADDRESS-MAP##
      
      // ##ARGUMENTS##
      
      const code = await getTransactionCode({
        name: "##TX-NAME##", 
        // ##ADDRESS-MAP-CONDITIONAL##
      });
      
      // ##GET-ACCOUNTS##
      // ##SIGNERS##
      
      // ##CODE-REPLACEMENT##

      let txResult;
      try {
        txResult = await sendTransaction({
          code,
          // ##SIGNERS-CONDITIONAL##
        });
      } catch (e) {
        console.log(e);
      }
      
      // Add your expectations here
      expect(txResult.errorMessage).toBe("");
      
    });
  `.replace(/##TX-NAME##/g, scriptName);

  if (addressMap.length > 0) {
    result = result.replace(/\/\/ ##ADDRESS-MAP##/, addressMap);
    result = result.replace(/\/\/ ##ADDRESS-MAP-CONDITIONAL##/, 'addressMap');
  } else {
    result = result.replace(/\/\/ ##ADDRESS-MAP##/, '');
    result = result.replace(/\/\/ ##ADDRESS-MAP-CONDITIONAL##/, '');
  }

  if (argumentsCode.length > 0) {
    result = result.replace(/\/\/ ##ARGUMENTS##/, argumentsCode);
    result = result.replace(/\/\/ ##ARGS-CONDITIONAL##/, 'args');
  } else {
    result = result.replace(/\/\/ ##ARGUMENTS##/, '');
    result = result.replace(/\/\/ ##ARGS-CONDITIONAL##/, '');
  }

  if (accountsCode.length > 0) {
    result = result.replace(/\/\/ ##GET-ACCOUNTS##/, accountsCode);
  } else {
    result = result.replace(/\/\/ ##GET-ACCOUNTS##/, '');
  }

  if (replacementCode.length > 0) {
    result = result.replace(/\/\/ ##CODE-REPLACEMENT##/, replacementCode);
  } else {
    result = result.replace(/\/\/ ##CODE-REPLACEMENT##/, '');
  }

  if (signersCode.length > 0) {
    result = result.replace(/\/\/ ##SIGNERS##/, signersCode);
    result = result.replace(/\/\/ ##SIGNERS-CONDITIONAL##/, 'signers');
  } else {
    result = result.replace(/\/\/ ##SIGNERS##/, '');
    result = result.replace(/\/\/ ##SIGNERS-CONDITIONAL##/, '');
  }

  return prettier.format(result, { parser: 'babel', plugins: [parserBabel] });
};

export const replaceContractTemplate = (
  accountAddress: string,
  template: string,
) => {
  let result = `
    test("Deploy ##CONTRACT-NAME## contract", async () => {
      const name = "##CONTRACT-NAME##"
      ##ADDRESS-MAP##
      ##TARGET-ADDRESS##
      
      let deployContract;
      try {
        deployContract = await deployContractByName({
          name, to, ##ADDRESS-MAP-CONDITIONAL##
        });
      } catch (e) {
        console.log(e);
      }
      expect(deployContract.errorMessage).toBe("");
    })
  `;

  const imports = getImports(template);
  const contractName = getContractName(template);
  const addressMap = generateAddressMap(imports);

  result = result.replace(
    /##TARGET-ADDRESS##/,
    generateContractTarget(accountAddress),
  );

  result = result.replace(/##CONTRACT-NAME##/g, contractName);

  if (addressMap.length > 0) {
    result = result.replace(/##ADDRESS-MAP##/, addressMap);
    result = result.replace(/##ADDRESS-MAP-CONDITIONAL##/, 'addressMap');
  } else {
    result = result.replace(/##ADDRESS-MAP##/, '');
    result = result.replace(/##ADDRESS-MAP-CONDITIONAL##/, '');
  }

  return prettier.format(result, { parser: 'babel', plugins: [parserBabel] });
};

export const generateContractUnitTest = (
  accountAddress: string,
  template: string,
) => {
  const imports = getImports(template);
  const contractName = getContractName(template);

  return contractUnitTestTemplate({
    accountAddress,
    contractName,
    imports,
  });
};

// TODO: should be replaced to "master" before merging or replaced with .env variable
const BRANCH = 'max/export-project-as-zip';
const GENERATOR_ROOT = `https://raw.githubusercontent.com/onflow/flow-playground/${BRANCH}/project-generator`;

export const getFile = async (filename: string) => {
  const response = await fetch(`${GENERATOR_ROOT}/${filename}`);
  return response.text();
};

export const generateReadMe = async (id: 'string') => {
  const file = await getFile('files/README.md');
  return file
    .replace(/##PROJECT-ID##/g, `${id.toLowerCase()}`)
    .replace(
      /##PROJECT-LINK##/g,
      `https://play.onflow.org/${id.toLowerCase()}`,
    );
};

export const generatePackageConfig = async (projectName: string) => {
  const file = await getFile('files/package.json');
  const config = file.replace(/##PROJECT-NAME##/g, projectName.toLowerCase());
  return config;
};

const generateTests = async (baseFolder: string, project: Project) => {
  const base = await getFile('snippets/imports.js');
  let content = base.replace(/##BASE-FOLDER##/, baseFolder);

  let deploymentTests = '';
  for (let i = 0; i < project.accounts.length; i++) {
    const account = project.accounts[i];
    const address = `0x0${account.address.slice(-1)}`;
    const code = account.draftCode;
    const unitTest = replaceContractTemplate(address, code);
    deploymentTests += unitTest;
    deploymentTests += '\n';
  }
  content = content.replace(/\/\/ ##DEPLOYMENT-TESTS##/, deploymentTests);

  let executionTests = '';
  for (let i = 0; i < project.transactionTemplates.length; i++) {
    const tx = project.transactionTemplates[i];
    const unitTest = replaceTransactionTemplate(tx.title, tx.script);
    executionTests += unitTest;
    executionTests += '\n';
  }

  for (let i = 0; i < project.scriptTemplates.length; i++) {
    const script = project.scriptTemplates[i];
    const unitTest = replaceScriptTemplate(script.title, script.script);
    executionTests += unitTest;
    executionTests += '\n';
  }
  content = content.replace(
    /\/\/ ##TRANSACTIONS-AND-SCRIPTS-TESTS##/,
    executionTests,
  );
  return prettier.format(content, { parser: 'babel', plugins: [parserBabel] });
};

export const createZip = async (
  folderName: string,
  projectName: string,
  project: Project,
) => {
  const zip = new JSZip();

  // Create setup files
  const readMeFile = await generateReadMe(project.id);
  const packageConfig = await generatePackageConfig(
    `playground-project-${project.id.toLowerCase()}`,
  );
  const babelConfig = await getFile('files/babel.config.json');
  const jestConfig = await getFile('files/package.json');
  const testFile = await generateTests(folderName, project);

  zip.file('test/README.md', readMeFile);
  zip.file('test/package.json', packageConfig);
  zip.file('test/babel.config.json', babelConfig);
  zip.file('test/jest.config.json', jestConfig);
  zip.file('test/index.test.js', testFile);

  const { accounts, transactionTemplates, scriptTemplates } = project;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const name = getContractName(account.draftCode);
    const fileName = `cadence/contracts/${name}.cdc`;
    zip.file(fileName, account.draftCode);
  }

  for (let i = 0; i < transactionTemplates.length; i++) {
    const template = transactionTemplates[i];
    const name = template.title;
    const fileName = `cadence/transactions/${name}.cdc`;
    zip.file(fileName, template.script);
  }

  for (let i = 0; i < scriptTemplates.length; i++) {
    const template = scriptTemplates[i];
    const name = template.title;
    const fileName = `cadence/scripts/${name}.cdc`;
    zip.file(fileName, template.script);
  }

  // Save everything as ZIP
  const projectFile = await zip.generateAsync({ type: 'blob' });
  saveAs(projectFile, `${projectName}.zip`);
};