'use strict';
var Promise = require('bluebird');
var models = require('../../models');
var security = require('../utils/security');
var _ = require('lodash');
var qetag = require('../utils/qetag');
var formidable = require('formidable');
var yazl = require("yazl");
var fs = require("fs");
var slash = require("slash");
var common = require('../utils/common');
var os = require('os');
var path = require('path');
var AppError = require('../app-error');
var log4js = require('log4js');
var constConfig = require('../const');
var log = log4js.getLogger("cps:PackageManager");

var proto = module.exports = function (){
  function PackageManager() {

  }
  PackageManager.__proto__ = proto;
  return PackageManager;
};

proto.getMetricsbyPackageId = function(packageId) {
  return models.PackagesMetrics.findOne({where: {package_id: packageId}});
}

proto.findPackageInfoByDeploymentIdAndLabel = function (deploymentId, label) {
  return models.Packages.findOne({where: {deployment_id: deploymentId, label:label}});
}

proto.findLatestPackageInfoByDeployVersion = function (deploymentsVersionsId) {
    return models.DeploymentsVersions.findById(deploymentsVersionsId)
    .then((deploymentsVersions)=>{
        if (!deploymentsVersions || deploymentsVersions.current_package_id < 0) {
          var e = new AppError.AppError("not found last packages");
          log.debug(e);
          throw e;
        }
        return models.Packages.findById(deploymentsVersions.current_package_id);
    });
}

proto.parseReqFile = function (req) {
  log.debug('parseReqFile');
  return new Promise((resolve, reject) => {
    var form = new formidable.IncomingForm();
    form.maxFieldsSize = 200 * 1024 * 1024;
    form.parse(req, (err, fields, files) => {
      if (err) {
        log.debug('parseReqFile:', err);
        reject(new AppError.AppError("upload error"));
      } else {
        log.debug('parseReqFile fields:', fields);
        log.debug('parseReqFile file location:', _.get(files,'package.path'));
        if (_.isEmpty(fields.packageInfo) || _.isEmpty(_.get(files,'package'))) {
          log.debug('parseReqFile upload info lack');
          reject(new AppError.AppError("upload info lack"));
        } else {
          log.debug('parseReqFile is ok');
          resolve({packageInfo: JSON.parse(fields.packageInfo), package: files.package});
        }
      }
    });
  });
};

proto.createDeploymentsVersionIfNotExist = function (deploymentId, appVersion, t) {
  return models.DeploymentsVersions.findOrCreate({
    where: {deployment_id: deploymentId, app_version: appVersion},
    defaults: {current_package_id: 0},
    transaction: t
  })
  .spread((data, created)=>{
    if (created) {
      log.debug(`createDeploymentsVersionIfNotExist findOrCreate version ${appVersion}`);
    }
    log.debug(`createDeploymentsVersionIfNotExist version data:`, data.get());
    return data;
  });
};

proto.isMatchPackageHash = function (packageId, packageHash) {
  if (_.lt(packageId, 0)) {
    log.debug(`isMatchPackageHash packageId is 0`);
    return Promise.resolve(false);
  }
  return models.Packages.findById(packageId)
  .then((data) => {
    if (data && _.eq(data.get('package_hash'), packageHash)){
      log.debug(`isMatchPackageHash data:`, data.get());
      log.debug(`isMatchPackageHash packageHash exist`);
      return true;
    }else {
      log.debug(`isMatchPackageHash package is null`);
      return false;
    }
  });
};

proto.createPackage = function (deploymentId, appVersion, packageHash, manifestHash, blobHash, params) {
  var releaseMethod = params.releaseMethod || constConfig.RELEAS_EMETHOD_UPLOAD;
  var releaseUid = params.releaseUid || 0;
  var isMandatory = params.isMandatory || 0;
  var size = params.size || 0;
  var rollout = params.rollout || 100;
  var description = params.description || "";
  var originalLabel = params.originalLabel || "";
  var isDisabled = params.isDisabled || 0;
  var originalDeployment = params.originalDeployment || "";
  var self = this;
  return models.Deployments.generateLabelId(deploymentId)
  .then((labelId) => {
    return models.sequelize.transaction((t) => {
      return self.createDeploymentsVersionIfNotExist(deploymentId, appVersion, t)
      .then((deploymentsVersions) => {
        return models.Packages.create({
          deployment_version_id: deploymentsVersions.id,
          deployment_id: deploymentId,
          description: description,
          package_hash: packageHash,
          blob_url: blobHash,
          size: size,
          manifest_blob_url: manifestHash,
          release_method: releaseMethod,
          label: "v" + labelId,
          released_by: releaseUid,
          is_mandatory: isMandatory,
          is_disabled: isDisabled,
          rollout: rollout,
          original_label: originalLabel,
          original_deployment: originalDeployment
        },{transaction: t})
        .then((packages) => {
          deploymentsVersions.set('current_package_id', packages.id);
          return Promise.all([
            deploymentsVersions.save({transaction: t}),
            models.Deployments.update(
              {last_deployment_version_id: deploymentsVersions.id},
              {where: {id: deploymentId}, transaction: t}
            ),
            models.PackagesMetrics.create(
              {package_id: packages.id},
              {transaction: t}
            ),
            models.DeploymentsHistory.create(
              {deployment_id: deploymentId,package_id: packages.id},
              {transaction: t}
            )
          ])
          .then(() => packages);
        });
      });
    });
  });
};

proto.downloadPackageAndExtract = function (workDirectoryPath, packageHash, blobHash) {
  var dataCenterManager = require('./datacenter-manager')();
  return dataCenterManager.validateStore(packageHash)
  .then((isValidate) => {
    if (isValidate) {
      return dataCenterManager.getPackageInfo(packageHash);
    } else {
      var downloadURL = common.getBlobDownloadUrl(blobHash);
      return common.createFileFromRequest(downloadURL, `${workDirectoryPath}/${blobHash}`)
      .then((download) => {
        return common.unzipFile(`${workDirectoryPath}/${blobHash}`, `${workDirectoryPath}/current`)
        .then((outputPath) => {
          return dataCenterManager.storePackage(outputPath, true);
        });
      });
    }
  });
}

proto.zipDiffPackage = function (fileName, files, baseDirectoryPath, hotCodePushFile) {
  return new Promise((resolve, reject) => {
    var zipFile = new yazl.ZipFile();
    var writeStream = fs.createWriteStream(fileName);
    writeStream.on('error', (error) => {
      reject(error);
    })
    zipFile.outputStream.pipe(writeStream)
    .on("error", (error) => {
      reject(error);
    })
    .on("close", () => {
      resolve({ isTemporary: true, path: fileName });
    });
    for (var i = 0; i < files.length; ++i) {
      var file = files[i];
      zipFile.addFile(`${baseDirectoryPath}/${file}`, slash(file));
    }
    zipFile.addFile(hotCodePushFile, 'hotcodepush.json');
    zipFile.end();
  });
}

proto.generateOneDiffPackage = function (workDirectoryPath, packageId, dataCenter, diffPackageHash, diffManifestBlobHash) {
  var self = this;
  return models.PackagesDiff.findOne({
    where:{
      package_id: packageId,
      diff_against_package_hash: diffPackageHash
    }
  })
  .then((diffPackage) => {
    if (!_.isEmpty(diffPackage)) {
      return;
    }
    var downloadURL = common.getBlobDownloadUrl(diffManifestBlobHash);
    return common.createFileFromRequest(downloadURL, `${workDirectoryPath}/${diffManifestBlobHash}`)
    .then(() => {
      var originContentPath = dataCenter.contentPath;
      var originManifestJson = JSON.parse(fs.readFileSync(dataCenter.manifestFilePath, "utf8"))
      var diffManifestJson = JSON.parse(fs.readFileSync(`${workDirectoryPath}/${diffManifestBlobHash}`, "utf8"))
      var json = common.diffCollectionsSync(originManifestJson, diffManifestJson);
      var files = _.concat(json.diff, json.collection1Only);
      var hotcodepush = {deletedFiles: json.collection2Only};
      var hotCodePushFile = `${workDirectoryPath}/${diffManifestBlobHash}_hotcodepush`;
      fs.writeFileSync(hotCodePushFile, JSON.stringify(hotcodepush));
      var fileName = `${workDirectoryPath}/${diffManifestBlobHash}.zip`;

      return self.zipDiffPackage(fileName, files, originContentPath, hotCodePushFile)
      .then((data) => {
        return security.qetag(data.path)
        .then((diffHash) => {
          log.debug('diff');
          return common.uploadFileToStorage(diffHash, fileName)
          .then(() => {
            var stats = fs.statSync(fileName);
            return models.PackagesDiff.create({
              package_id: packageId,
              diff_against_package_hash: diffPackageHash,
              diff_blob_url: diffHash,
              diff_size: stats.size
            });
          })
        });
      });
    });
  });
};

proto.createDiffPackagesByLastNums = function (packageId, num) {
  var self = this;
  return models.Packages.findById(packageId)
  .then((originalPackage) => {
    if (_.isEmpty(originalPackage)) {
      throw AppError.AppError('can\'t find Package');
    }
    var Sequelize = require('sequelize');
    return Promise.all([
      models.Packages.findAll({
        where:{
          deployment_version_id: originalPackage.deployment_version_id,
          id: {[Sequelize.Op.lt]: packageId}},
          order: [['id','desc']],
          limit: num
      }),
      models.Packages.findAll({
        where:{
          deployment_version_id: originalPackage.deployment_version_id,
          id: {[Sequelize.Op.lt]: packageId}},
          order: [['id','asc']],
          limit: 2
      })
    ])
    .spread((lastNumsPackages, basePackages) => {
      return _.unionBy(lastNumsPackages, basePackages, 'id');
    })
    .then((lastNumsPackages) => {
      return self.createDiffPackages(originalPackage, lastNumsPackages);
    });
  });
};

proto.createDiffPackages = function (originalPackage, destPackages) {
  if (!_.isArray(destPackages)) {
    return Promise.reject(new AppError.AppError('第二个参数必须是数组'));
  }
  if (destPackages.length <= 0) {
    return null;
  }
  var self = this;
  var package_hash = _.get(originalPackage, 'package_hash');
  var manifest_blob_url = _.get(originalPackage, 'manifest_blob_url');
  var blob_url = _.get(originalPackage, 'blob_url');
  var workDirectoryPath = path.join(os.tmpdir(), 'codepush_' + security.randToken(32));
  return common.createEmptyFolder(workDirectoryPath)
  .then(() => self.downloadPackageAndExtract(workDirectoryPath, package_hash, blob_url))
  .then((dataCenter) => Promise.map(destPackages,
    (v) => self.generateOneDiffPackage(workDirectoryPath, originalPackage.id, dataCenter, v.package_hash, v.manifest_blob_url)
  ))
  .finally(() => common.deleteFolderSync(workDirectoryPath));
}

proto.releasePackage = function (appId, deploymentId, packageInfo, filePath, releaseUid) {
  var self = this;
  var appVersion = packageInfo.appVersion;
  if (!/^([0-9.]+)$/.test(appVersion)) {
    log.debug(`releasePackage targetBinaryVersion ${appVersion} not support.`);
    return Promise.reject(new AppError.AppError(`targetBinaryVersion ${appVersion} not support.`))
  }
  var description = packageInfo.description; //描述
  var isDisabled = packageInfo.isDisabled; //是否立刻下载
  var rollout = packageInfo.rollout; //灰度百分比
  var isMandatory = packageInfo.isMandatory; //是否强制更新，无法跳过
  var tmpDir = os.tmpdir();
  var directoryPath = path.join(tmpDir, 'codepush_' + security.randToken(32));
  log.debug(`releasePackage generate an random dir path: ${directoryPath}`);
  return Promise.all([
    security.qetag(filePath),
    common.createEmptyFolder(directoryPath)
    .then(() => {
      return common.unzipFile(filePath, directoryPath)
    })
  ])
  .spread((blobHash) => {
    return security.uploadPackageType(directoryPath)
    .then((type) => {
      return models.Apps.findById(appId).then((appInfo)=>{
        if (type > 0 && appInfo.os > 0 && appInfo.os != type) {
            var e = new AppError.AppError("it must be publish it by ios type");
            log.debug(e);
            throw e;
        } else {
          //不验证
          log.debug(`Unknown package type:`, type, ',db os:', appInfo.os);
        }
        return blobHash;
      });
    });
  })
  .then((blobHash) => {
    var dataCenterManager = require('./datacenter-manager')();
    return dataCenterManager.storePackage(directoryPath)
    .then((dataCenter) => {
      var packageHash = dataCenter.packageHash;
      var manifestFile = dataCenter.manifestFilePath;
      return self.createDeploymentsVersionIfNotExist(deploymentId, appVersion)
      .then((deploymentsVersions) => {
        return self.isMatchPackageHash(deploymentsVersions.get('current_package_id'), packageHash);
      })
      .then((isExist) => {
        if (isExist){
          var e = new AppError.AppError("The uploaded package is identical to the contents of the specified deployment's current release.");
          log.debug(e.message);
          throw e;
        }
        return security.qetag(manifestFile);
      })
      .then((manifestHash) => {
        return Promise.all([
          common.uploadFileToStorage(manifestHash, manifestFile),
          common.uploadFileToStorage(blobHash, filePath)
        ])
        .then(() => [packageHash, manifestHash, blobHash]);
      })
    });
  })
  .spread((packageHash, manifestHash, blobHash) => {
    var stats = fs.statSync(filePath);
    var params = {
      releaseMethod: constConfig.RELEAS_EMETHOD_UPLOAD,
      releaseUid: releaseUid,
      isMandatory: isMandatory ? constConfig.IS_MANDATORY_YES : constConfig.IS_MANDATORY_NO,
      isDisabled: isDisabled ? constConfig.IS_DISABLED_YES : constConfig.IS_DISABLED_NO,
      rollout: rollout,
      size: stats.size,
      description: description
    }
    return self.createPackage(deploymentId, appVersion, packageHash, manifestHash, blobHash, params);
  })
  .finally(() => common.deleteFolderSync(directoryPath))
};

proto.modifyReleasePackage = function(packageId, params) {
  var appVersion = _.get(params, 'appVersion');
  var description = _.get(params, 'description');
  var isMandatory = _.get(params, 'isMandatory');
  var isDisabled = _.get(params, 'isDisabled');
  var rollout = _.get(params, 'rollout');
  return models.Packages.findById(packageId)
  .then((packageInfo) => {
    if (!packageInfo) {
      throw new AppError.AppError(`packageInfo not found`);
    }
    var new_params = {
      description: description || packageInfo.description,
      is_mandatory: isMandatory ? constConfig.IS_MANDATORY_YES : constConfig.IS_MANDATORY_NO,
      is_disabled: isDisabled ? constConfig.IS_DISABLED_YES : constConfig.IS_DISABLED_NO,
      rollout: rollout || 100
    };
    return models.Packages.update(new_params,{where: {id: packageId}});
  });
};

proto.promotePackage = function (sourceDeploymentId, destDeploymentId, params) {
  var self = this;
  var appVersion = params.appVersion;
  return models.Deployments.findById(sourceDeploymentId)
  .then((sourceDeployment) => {
    if (appVersion) {
      return models.DeploymentsVersions.findOne({where: {deployment_id: sourceDeploymentId, app_version:appVersion}})
      .then((deploymentsVersions)=>{return [sourceDeployment, deploymentsVersions]});
    } else {
      var lastDeploymentVersionId = _.get(sourceDeployment, 'last_deployment_version_id', 0);
      if (_.lte(lastDeploymentVersionId, 0)) {
        throw new AppError.AppError('does not exist last_deployment_version_id.');
      }
      return models.DeploymentsVersions.findById(lastDeploymentVersionId)
      .then((deploymentsVersions)=>{return [sourceDeployment, deploymentsVersions]});
    }
  })
  .spread((sourceDeployment, deploymentsVersions) => {
    if (!deploymentsVersions) {
      throw new AppError.AppError('does not exist deployment_version.');
    }
    log.debug('deploymentsVersions',deploymentsVersions);
    var packageId = _.get(deploymentsVersions, 'current_package_id', 0);
    if (_.lte(packageId, 0)) {
      throw new AppError.AppError('does not exist packages.');
    }
    return models.Packages.findById(packageId)
    .then((packages) => {
      if (!packages) {
        throw new AppError.AppError('does not exist packages.');
      }
      return self.createDeploymentsVersionIfNotExist(destDeploymentId, deploymentsVersions.app_version)
      .then((deploymentsVersions) => {
        return self.isMatchPackageHash(deploymentsVersions.get('current_package_id'), packages.package_hash);
      })
      .then((isExist) => {
        if (isExist){
          throw new AppError.AppError("The uploaded package is identical to the contents of the specified deployment's current release.");
        }
      })
      .then(() => [sourceDeployment, deploymentsVersions, packages]);
    });
  })
  .spread((sourceDeployment, deploymentsVersions, packages) => {
    var create_params = {
      releaseMethod: constConfig.RELEAS_EMETHOD_PROMOTE,
      releaseUid: params.promoteUid || 0,
      isMandatory: params.isMandatory ? constConfig.IS_MANDATORY_YES : constConfig.IS_MANDATORY_NO,
      isDisabled: params.isDisabled ? constConfig.IS_DISABLED_YES : constConfig.IS_DISABLED_NO,
      rollout: params.rollout || packages.rollout,
      size: packages.size,
      description: packages.description,
      originalLabel: packages.label,
      originalDeployment: sourceDeployment.name
    };
    return self.createPackage(destDeploymentId, deploymentsVersions.app_version, packages.package_hash, packages.manifest_blob_url, packages.blob_url, create_params);
  });
};

proto.rollbackPackage = function (deploymentVersionId, targetLabel, rollbackUid) {
  var self = this;
  return models.DeploymentsVersions.findById(deploymentVersionId)
  .then((deploymentsVersions) => {
    if (!deploymentsVersions) {
      throw new AppError.AppError("您之前还没有发布过版本");
    }
    return models.Packages.findById(deploymentsVersions.current_package_id)
    .then((currentPackageInfo) => {
      if (targetLabel) {
        return models.Packages.findAll({where: {deployment_version_id: deploymentVersionId, label: targetLabel}, limit: 1})
        .then((rollbackPackageInfos) => {
          return [currentPackageInfo, rollbackPackageInfos]
        });
      } else {
        return self.getCanRollbackPackages(deploymentVersionId)
        .then((rollbackPackageInfos) => {
          return [currentPackageInfo, rollbackPackageInfos]
        });
      }
    })
    .spread((currentPackageInfo, rollbackPackageInfos) => {
      if (currentPackageInfo && rollbackPackageInfos.length > 0) {
        for (var i = rollbackPackageInfos.length - 1; i >= 0; i--) {
          if (rollbackPackageInfos[i].package_hash != currentPackageInfo.package_hash) {
            return rollbackPackageInfos[i];
          }
        }
      }
      throw new AppError.AppError("没有可供回滚的版本");
    })
    .then((rollbackPackage) => {
      var params = {
        releaseMethod: 'Rollback',
        releaseUid: rollbackUid,
        isMandatory: rollbackPackage.is_mandatory,
        isDisabled: packages.is_disabled,
        rollout: packages.rollout,
        size: rollbackPackage.size,
        description: rollbackPackage.description,
        originalLabel: rollbackPackage.label,
        originalDeployment: ''
      };
      return self.createPackage(deploymentsVersions.deployment_id,
        deploymentsVersions.app_version,
        rollbackPackage.package_hash,
        rollbackPackage.manifest_blob_url,
        rollbackPackage.blob_url,
        params
      );
    });
  });
}

proto.getCanRollbackPackages = function (deploymentVersionId) {
  var Sequelize = require('sequelize');
  return models.Packages.findAll({
    where: {
      deployment_version_id: deploymentVersionId,
      release_method: {[Sequelize.Op.in]: [constConfig.RELEAS_EMETHOD_UPLOAD, constConfig.RELEAS_EMETHOD_PROMOTE] }
    }, order: [['id','desc']], limit: 2
  });
}
