//Requires
const modulename = 'WebServer:SetupPost';
const fs = require('fs-extra');
const slash = require('slash');
const path = require('path');
const axios = require("axios");
const { dir, log, logOk, logWarn, logError } = require('../../extras/console')(modulename);
const { Deployer, validateTargetPath, parseRecipe } = require('../../extras/deployer');
const helpers = require('../../extras/helpers');

//Helper functions
const isUndefined = (x) => { return (typeof x === 'undefined') };

const getDirectories = (source) => {
    return fs.readdirSync(source, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
}
    
const getPotentialServerDataFolders = (source) => {
    try {
        return getDirectories(source)
            .filter(dirent => getDirectories(path.join(source, dirent)).includes('resources'))
            .map(dirent => slash(path.join(source, dirent))+'/')
    } catch (error) {
        if(GlobalData.verbose) logWarn(`Failed to find server data folder with message: ${error.message}`)
        return []
    }
}

/*
    NOTE: How forgiving are we:
        - Ignore trailing slashes, as well as fix backslashes
        - Check if its the parent folder
        - Check if its inside the parent folder
        - Check if its inside current folder
        - Check if it contains the string `/resources`, then if its the path up to that string
        - For the cfg file, we check if its `server.cfg` inside the Server Data Folder (most common case)

    FIXME: Also note that this entire file is a bit too messy, please clean it up a bit
*/

/**
 * Handle all the server control actions
 * @param {object} ctx
 */
module.exports = async function SetupPost(ctx) {
    //Sanity check
    if(isUndefined(ctx.params.action)){
        return ctx.utils.error(400, 'Invalid Request');
    }
    const action = ctx.params.action;

    //Check permissions
    if(!ctx.utils.checkPermission('all_permissions', modulename)){
        return ctx.send({
            success: false, 
            message: `You need to be the admin master to use the setup page.`
        });
    }

    //Check if this is the correct state for the setup page
    if(
        globals.deployer !== null ||
        (globals.fxRunner.config.serverDataPath !== null && globals.fxRunner.config.cfgPath !== null)
    ){
        return ctx.send({
            success: false, 
            refresh: true
        });
    }

    //Delegate to the specific action functions
    if(action == 'validateRecipeURL'){
        return await handleValidateRecipeURL(ctx);

    }else if(action == 'validateLocalDeployPath'){
        return await handleValidateLocalDeployPath(ctx);

    }else if(action == 'validateLocalDataFolder'){
        return await handleValidateLocalDataFolder(ctx);

    }else if(action == 'validateCFGFile'){
        return await handleValidateCFGFile(ctx);

    }else if(action == 'save'){
        const handler = (ctx.request.body.template == 'true')? handleSaveDeployer : handleSaveLocal;
        return await handler(ctx);

    }else{
        return ctx.send({
            success: false, 
            message: 'Unknown setup action.'
        });
    }
};


//================================================================
/**
 * Handle Validation of a remote recipe/template URL
 * @param {object} ctx
 */
async function handleValidateRecipeURL(ctx) {
    //Sanity check
    if(isUndefined(ctx.request.body.recipeURL)){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }
    const recipeURL = ctx.request.body.recipeURL.trim();

    //Make request & validate recipe
    try {
        const res = await axios({
            url: recipeURL,
            method: 'get',
            responseEncoding: 'utf8',
            timeout: 4500
        });
        if(typeof res.data !== 'string') throw new Error('This URL did not return a string.');
        const recipe = parseRecipe(res.data);
        return ctx.send({success: true, name: recipe.name});
    } catch (error) {
        return ctx.send({success: false, message: `Recipe error: ${error.message}`});
    }
}


//================================================================
/**
 * Handle Validation of a remote recipe/template URL
 * @param {object} ctx
 */
async function handleValidateLocalDeployPath(ctx) {
    //Sanity check
    if(isUndefined(ctx.request.body.deployPath)){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }
    const deployPath = slash(path.normalize(ctx.request.body.deployPath.trim()));
    if(deployPath.includes(' ')){
        return ctx.send({success: false, message: 'The path cannot contain spaces.'});
    }

    //Perform path checking
    try {
        return ctx.send({success: true, message: await validateTargetPath(deployPath)});
    } catch (error) {
        return ctx.send({success: false, message: error.message});
    }
}


//================================================================
/**
 * Handle Validation of Local (existing) Server Data Folder
 * @param {object} ctx
 */
async function handleValidateLocalDataFolder(ctx) {
    //Sanity check
    if(isUndefined(ctx.request.body.dataFolder)){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }
    const dataFolderPath = slash(path.normalize(ctx.request.body.dataFolder.trim()+'/'));
    if(dataFolderPath.includes(' ')){
        return ctx.send({success: false, message: 'The path cannot contain spaces.'});
    }

    try {
        if(!fs.existsSync(path.join(dataFolderPath, 'resources'))){
            let recoveryTemplate = `The path provided is invalid. <br>
                But it looks like <code>{{attempt}}</code> is correct. <br>
                Do you want to use it instead?`;

            //Recovery if parent folder
            let attemptIsParent = path.join(dataFolderPath, '..');
            if(fs.existsSync(path.join(attemptIsParent, 'resources'))){
                let message = recoveryTemplate.replace('{{attempt}}', attemptIsParent);
                return ctx.send({success: false, message, suggestion: attemptIsParent});
            }

            //Recovery parent inside folder
            let attemptOutside = getPotentialServerDataFolders(path.join(dataFolderPath, '..'));
            if(attemptOutside.length >= 1){
                let message = recoveryTemplate.replace('{{attempt}}', attemptOutside[0]);
                return ctx.send({success: false, message, suggestion: attemptOutside[0]});
            }

            //Recovery if resources
            if(dataFolderPath.includes('/resources')){
                let attemptRes = dataFolderPath.split('/resources')[0];
                if(fs.existsSync(path.join(attemptRes, 'resources'))){
                    let message = recoveryTemplate.replace('{{attempt}}', attemptRes);
                    return ctx.send({success: false, message, suggestion: attemptRes});
                }
            }

            //Recovery subfolder
            let attemptInside = getPotentialServerDataFolders(dataFolderPath);
            if(attemptInside.length >= 1){
                let message = recoveryTemplate.replace('{{attempt}}', attemptInside[0]);
                return ctx.send({success: false, message, suggestion: attemptInside[0]});
            }

            //really invalid :(
            throw new Error("Couldn't locate or read a resources folder inside of the path provided.");

        }else{
            return ctx.send({success: true});
        }
    } catch (error) {
        return ctx.send({success: false, message: error.message});
    }
}


//================================================================
/**
 * Handle Validation of CFG File
 * @param {object} ctx
 */
async function handleValidateCFGFile(ctx) {
    //Sanity check
    if(
        isUndefined(ctx.request.body.dataFolder) ||
        isUndefined(ctx.request.body.cfgFile)
    ){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    let dataFolderPath = slash(path.normalize(ctx.request.body.dataFolder.trim()));
    let cfgFilePath = slash(path.normalize(ctx.request.body.cfgFile.trim()));
    cfgFilePath = helpers.resolveCFGFilePath(cfgFilePath, dataFolderPath);
    if(cfgFilePath.includes(' ')){
        return ctx.send({success: false, message: 'The path cannot contain spaces.'});
    }

    let rawCfgFile;
    try {
        rawCfgFile = helpers.getCFGFileData(cfgFilePath);
    } catch (error) {
        try {
            let attempt = path.join(dataFolderPath, 'server.cfg');
            rawCfgFile = helpers.getCFGFileData(attempt);
            let message = `The path provided is invalid. <br>
                    But it looks like <code>${attempt}</code> is correct. <br>
                    Do you want to use it instead?`;
            return ctx.send({success: false, message, suggestion: attempt});
        } catch (error2) {}

        return ctx.send({success: false, message: error.message});
    }
    
    try {
        let port = helpers.getFXServerPort(rawCfgFile);
        return ctx.send({success: true});
    } catch (error) {
        let message = `The file path is correct, but: <br>\n ${error.message}.`;
        return ctx.send({success: false, message});
    }
}


//================================================================
/**
 * Handle Save settings
 * Actions: sets serverDataPath/cfgPath, starts the server, redirect to live console
 * @param {object} ctx
 */
async function handleSaveLocal(ctx) {
    //Sanity check
    if(
        isUndefined(ctx.request.body.name) ||
        isUndefined(ctx.request.body.dataFolder) ||
        isUndefined(ctx.request.body.cfgFile)
    ){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }

    //Prepare body input
    const cfg = {
        name: ctx.request.body.name.trim(),
        dataFolder: slash(path.normalize(ctx.request.body.dataFolder+'/')),
        cfgFile: slash(path.normalize(ctx.request.body.cfgFile))
    }

    //Validating path spaces
    if(cfg.dataFolder.includes(' ') || cfg.cfgFile.includes(' ')){
        return ctx.send({success: false, message: 'The paths cannot contain spaces.'});
    }

    //Validating Base Path
    try {
        if(!fs.existsSync(path.join(cfg.dataFolder, 'resources'))){
            throw new Error("Invalid path");
        }
    } catch (error) {
        return ctx.send({success: false, message: `<strong>Server Data Folder error:</strong> ${error.message}`});
    }

    //Validating CFG Path
    try {
        const cfgFilePath = helpers.resolveCFGFilePath(cfg.cfgFile, cfg.dataFolder);
        const rawCfgFile = helpers.getCFGFileData(cfgFilePath);
        const port = helpers.getFXServerPort(rawCfgFile);
    } catch (error) {
        return ctx.send({success: false, message: `<strong>CFG File error:</strong> ${error.message}`});
    }

    //Preparing & saving config
    const newGlobalConfig = globals.configVault.getScopedStructure('global');
    newGlobalConfig.serverName = cfg.name;
    const saveGlobalStatus = globals.configVault.saveProfile('global', newGlobalConfig);

    const newFXRunnerConfig = globals.configVault.getScopedStructure('fxRunner');
    newFXRunnerConfig.serverDataPath = cfg.dataFolder;
    newFXRunnerConfig.cfgPath = cfg.cfgFile;
    const saveFXRunnerStatus = globals.configVault.saveProfile('fxRunner', newFXRunnerConfig);
    

    //Sending output
    if(saveGlobalStatus && saveFXRunnerStatus){
        //Refreshing config
        globals.config = globals.configVault.getScoped('global');
        globals.fxRunner.refreshConfig();

        //Logging
        const logMessage = `[${ctx.ip}][${ctx.session.auth.username}] Changing global/fxserver settings via setup stepper.`;
        logOk(logMessage);
        globals.logger.append(logMessage);

        //Starting server
        const spawnMsg = await globals.fxRunner.spawnServer(false);
        if(spawnMsg !== null){
            return ctx.send({success: false, message: `Faied to start server with error: <br>\n${spawnMsg}`});
        }else{
            return ctx.send({success: true});
        }
    }else{
        logWarn(`[${ctx.ip}][${ctx.session.auth.username}] Error changing global/fxserver settings via setup stepper.`);
        return ctx.send({success: false, message: `<strong>Error saving the configuration file.</strong>`});
    }
}



//================================================================
/**
 * Handle Save settings
 * Actions: download recipe, globals.deployer = new Deployer(recipe)
 * @param {object} ctx
 */
async function handleSaveDeployer(ctx) {
    //Sanity check
    if(
        isUndefined(ctx.request.body.name) ||
        isUndefined(ctx.request.body.recipeURL) ||
        isUndefined(ctx.request.body.targetPath)
    ){
        return ctx.utils.error(400, 'Invalid Request - missing parameters');
    }
    const serverName = ctx.request.body.name.trim();
    const recipeURL = ctx.request.body.recipeURL.trim();
    const targetPath = slash(path.normalize(ctx.request.body.targetPath+'/')); 

    //Get and validate recipe
    let recipeData;
    try {
        const res = await axios({
            url: recipeURL,
            method: 'get',
            responseEncoding: 'utf8',
            timeout: 4500
        });
        if(typeof res.data !== 'string') throw new Error('This URL did not return a string.');
        recipeData = res.data;
    } catch (error) {
        return ctx.send({success: false, message: `Recipe error: ${error.message}`});
    }
    
    //Initiate deployer
    globals.deployer = new Deployer(recipeData, targetPath);

    //Preparing & saving config
    const newGlobalConfig = globals.configVault.getScopedStructure('global');
    newGlobalConfig.serverName = serverName;
    const saveGlobalStatus = globals.configVault.saveProfile('global', newGlobalConfig);
    
    //Checking save and redirecting
    if(saveGlobalStatus){
        const logMessage = `[${ctx.ip}][${ctx.session.auth.username}] Changing global settings via setup stepper and started Deployer`;
        logOk(logMessage);
        globals.logger.append(logMessage);
        return ctx.send({success: true});
    }else{
        logWarn(`[${ctx.ip}][${ctx.session.auth.username}] Error changing global settings via setup stepper.`);
        return ctx.send({success: false, message: `<strong>Error saving the configuration file.</strong>`});
    }
}

